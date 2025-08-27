use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use bytes::Bytes;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Sample, SampleFormat, SizedSample};

// Commands for the audio manager
pub enum AudioCommand {
    Start(mpsc::Sender<Bytes>),
    Stop,
}

// Audio manager that handles recording
pub struct AudioManager {
    command_rx: mpsc::Receiver<AudioCommand>,
    active_stream: Mutex<Option<cpal::Stream>>,
    active_sender: Arc<Mutex<Option<mpsc::Sender<Bytes>>>>,
}

impl AudioManager {
    // Create a new audio manager
    pub fn new(command_rx: mpsc::Receiver<AudioCommand>) -> Self {
        Self {
            command_rx,
            active_stream: Mutex::new(None),
            active_sender: Arc::new(Mutex::new(None)),
        }
    }

    // Run the audio manager
    pub async fn run(&mut self) {
        while let Some(command) = self.command_rx.recv().await {
            match command {
                AudioCommand::Start(audio_tx) => {
                    println!("Audio manager: Starting recording");
                    
                    // Stop any existing stream
                    {
                        let mut stream = self.active_stream.lock().unwrap();
                        *stream = None;
                    }
                    
                    // Store the new sender
                    {
                        let mut sender = self.active_sender.lock().unwrap();
                        *sender = Some(audio_tx);
                    }
                    
                    // Start a new recording
                    match self.record_audio() {
                        Ok(stream) => {
                            let mut stream_lock = self.active_stream.lock().unwrap();
                            *stream_lock = Some(stream);
                            println!("Audio manager: Recording started");
                        },
                        Err(e) => {
                            eprintln!("Audio manager: Failed to start recording: {}", e);
                            if let Some(tx) = &*self.active_sender.lock().unwrap() {
                                let _ = tx.try_send(Bytes::from(format!("Error: {}", e)));
                            }
                        }
                    }
                },
                AudioCommand::Stop => {
                    println!("Audio manager: Stopping recording");
                    let mut stream = self.active_stream.lock().unwrap();
                    *stream = None;
                    let mut sender = self.active_sender.lock().unwrap();
                    *sender = None;
                    println!("Audio manager: Recording stopped");
                }
            }
        }
    }

    // Record audio
    fn record_audio(&self) -> Result<cpal::Stream, String> {
        // Get default host
        let host = cpal::default_host();
        
        // Get default input device
        let device = host.default_input_device()
            .ok_or_else(|| "No input device available".to_string())?;
        
        println!("Using input device: {}", device.name().unwrap_or_else(|_| "Unknown".to_string()));
        
        // Get default config
        let config = device.default_input_config()
            .map_err(|e| format!("Failed to get default input config: {}", e))?;
        
        println!("Default input config: {:?}", config);
        
        // Create stream with config
        let err_fn = |err| eprintln!("an error occurred on the audio stream: {}", err);
        
        let active_sender = Arc::clone(&self.active_sender);
        
        let stream = match config.sample_format() {
            SampleFormat::F32 => self.create_stream::<f32>(&device, &config.into(), active_sender, err_fn),
            SampleFormat::I16 => self.create_stream::<i16>(&device, &config.into(), active_sender, err_fn),
            SampleFormat::U16 => self.create_stream::<u16>(&device, &config.into(), active_sender, err_fn),
            _ => return Err("Unsupported sample format".to_string()),
        }.map_err(|e| format!("Failed to build stream: {}", e))?;
        
        // Start the stream
        stream.play().map_err(|e| format!("Failed to start stream: {}", e))?;
        
        Ok(stream)
    }

    // Create an audio stream with the given format
    fn create_stream<T>(
        &self,
        device: &cpal::Device,
        config: &cpal::StreamConfig,
        active_sender: Arc<Mutex<Option<mpsc::Sender<Bytes>>>>,
        err_fn: impl FnMut(cpal::StreamError) + Send + 'static,
    ) -> Result<cpal::Stream, cpal::BuildStreamError>
    where
        T: Sample + SizedSample + Send + 'static,
        T::Float: Into<f32>,
    {
        device.build_input_stream(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                // Convert samples to bytes
                let bytes: Vec<u8> = data.iter()
                    .flat_map(|sample| {
                        // Convert to f32 using the Sample trait method
                        let sample_f32: f32 = sample.to_float_sample().into();
                        // Convert f32 to bytes (4 bytes per sample)
                        sample_f32.to_le_bytes().to_vec()
                    })
                    .collect();
                
                // Send bytes to WebSocket if sender is available
                let bytes = Bytes::from(bytes);
                if let Some(tx) = &*active_sender.lock().unwrap() {
                    let _ = tx.try_send(bytes);
                }
            },
            err_fn,
            None,
        )
    }
}