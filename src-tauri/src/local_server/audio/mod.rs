use bytes::Bytes;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::{mpsc, oneshot};

// Message types for the audio stream
#[derive(Debug, Clone)]
pub enum AudioStreamMessage {
    Data(Bytes),
    Error(String),
}

// Commands for the audio manager
pub enum AudioCommand {
    Start {
        audio_tx: mpsc::Sender<AudioStreamMessage>,
        response_tx: oneshot::Sender<Result<(), String>>,
    },
    Stop,
}

// Audio manager that handles recording
pub struct AudioManager {
    command_rx: mpsc::Receiver<AudioCommand>,
    active_stream: Mutex<Option<cpal::Stream>>,
    active_sender: Arc<Mutex<Option<mpsc::Sender<AudioStreamMessage>>>>,
    is_recording: AtomicBool,
    target_sample_rate: u32,
}

impl AudioManager {
    // Create a new audio manager
    pub fn new(command_rx: mpsc::Receiver<AudioCommand>, target_sample_rate: u32) -> Self {
        Self {
            command_rx,
            active_stream: Mutex::new(None),
            active_sender: Arc::new(Mutex::new(None)),
            is_recording: AtomicBool::new(false),
            target_sample_rate,
        }
    }

    // Run the audio manager
    pub async fn run(&mut self) {
        while let Some(command) = self.command_rx.recv().await {
            match command {
                AudioCommand::Start { audio_tx, response_tx } => {
                    tracing::debug!("Audio manager: Received start recording command");

                    // Check if already recording - reject if so
                    if self.is_recording.compare_exchange(
                        false,
                        true,
                        Ordering::SeqCst,
                        Ordering::SeqCst,
                    ).is_err() {
                        tracing::warn!("Audio manager: Recording already in progress - rejecting request");
                        let _ = response_tx.send(Err("Recording already in progress".to_string()));
                        continue;
                    }

                    // Stop any existing stream (shouldn't happen but be safe)
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
                            tracing::info!("Audio manager: Recording started successfully");
                            let _ = response_tx.send(Ok(()));
                        }
                        Err(e) => {
                            tracing::error!("Audio manager: Failed to start recording: {}", e);
                            
                            // Send error to client
                            if let Some(tx) = &*self.active_sender.lock().unwrap() {
                                let _ = tx.try_send(AudioStreamMessage::Error(e.clone()));
                            }
                            
                            // Cleanup state
                            self.cleanup_state();
                            
                            // Notify handler of failure
                            let _ = response_tx.send(Err(e));
                        }
                    }
                }
                AudioCommand::Stop => {
                    tracing::debug!("Audio manager: Stopping recording");
                    self.cleanup_state();
                    tracing::debug!("Audio manager: Recording stopped and state cleaned up");
                }
            }
        }
    }

    // Cleanup recording state
    fn cleanup_state(&self) {
        // Stop stream
        let mut stream = self.active_stream.lock().unwrap();
        *stream = None;
        
        // Clear sender
        let mut sender = self.active_sender.lock().unwrap();
        *sender = None;
        
        // Reset recording flag
        self.is_recording.store(false, Ordering::SeqCst);
    }

    // Record audio
    fn record_audio(&self) -> Result<cpal::Stream, String> {
        // Get default host
        let host = cpal::default_host();

        // Get default input device
        let device = host
            .default_input_device()
            .ok_or_else(|| "No input device available".to_string())?;

        tracing::info!(
            "Using input device: {}",
            device.name().unwrap_or_else(|_| "Unknown".to_string())
        );

        // Get default config - use whatever the device supports
        let default_config = device
            .default_input_config()
            .map_err(|e| format!("Failed to get default input config: {}", e))?;

        let device_sample_rate = default_config.sample_rate().0;
        let channels = default_config.channels() as usize;
        let sample_format = default_config.sample_format();

        tracing::debug!(
            "Device native sample rate: {}Hz, channels: {}, format: {:?}",
            device_sample_rate, channels, sample_format
        );

        // Use the device's default configuration
        let config = cpal::StreamConfig {
            channels: default_config.channels(),
            sample_rate: default_config.sample_rate(),
            buffer_size: cpal::BufferSize::Default,
        };

        tracing::debug!(
            "Using device configuration: {}Hz (will resample to {}Hz)",
            device_sample_rate, self.target_sample_rate
        );

        // Clone components needed for error callback
        let active_sender_for_err = Arc::clone(&self.active_sender);
        let is_recording_for_err = Arc::new(AtomicBool::new(true));
        let is_recording_clone = Arc::clone(&is_recording_for_err);
        
        let err_fn = move |err: cpal::StreamError| {
            tracing::error!("Audio stream error occurred: {}", err);
            
            // Send an error message to a client
            if let Some(tx) = &*active_sender_for_err.lock().unwrap() {
                let error_msg = format!("Audio stream error: {}", err);
                let _ = tx.try_send(AudioStreamMessage::Error(error_msg));
            }
            
            // Mark that we've handled the error (prevents duplicate error handling)
            is_recording_clone.store(false, Ordering::SeqCst);
        };

        let active_sender = Arc::clone(&self.active_sender);

        // Create resampler if sample rates differ
        let needs_resampling = device_sample_rate != self.target_sample_rate;
        let resampler = if needs_resampling {
            tracing::debug!("Creating resampler: {} -> {}", device_sample_rate, self.target_sample_rate);
            
            // Create a high-quality resampler
            let params = SincInterpolationParameters {
                sinc_len: 256,
                f_cutoff: 0.95,
                interpolation: SincInterpolationType::Linear,
                oversampling_factor: 256,
                window: WindowFunction::BlackmanHarris2,
            };
            
            // Calculate chunk size for resampler (process ~20ms at a time)
            let chunk_size = (device_sample_rate as f64 * 0.02) as usize;
            
            match SincFixedIn::<f32>::new(
                self.target_sample_rate as f64 / device_sample_rate as f64,
                2.0,
                params,
                chunk_size,
                channels,
            ) {
                Ok(r) => Some(Arc::new(Mutex::new(r))),
                Err(e) => {
                    tracing::error!("Failed to create resampler: {}", e);
                    return Err(format!("Failed to create resampler: {}", e));
                }
            }
        } else {
            tracing::debug!("No resampling needed");
            None
        };

        // Buffer for accumulating samples before resampling
        let sample_buffer: Arc<Mutex<Vec<Vec<f32>>>> = Arc::new(Mutex::new(
            vec![Vec::new(); channels]
        ));

        // Create stream based on device's native format
        let stream = match sample_format {
            cpal::SampleFormat::F32 => self.create_stream_f32(
                &device,
                &config,
                active_sender,
                err_fn,
                resampler,
                sample_buffer,
                channels,
            ),
            cpal::SampleFormat::I16 => self.create_stream_i16(
                &device,
                &config,
                active_sender,
                err_fn,
                resampler,
                sample_buffer,
                channels,
            ),
            _ => {
                return Err(format!(
                    "Unsupported sample format: {:?}. Only F32 and I16 are supported.",
                    sample_format
                ));
            }
        }
        .map_err(|e| format!("Failed to build stream: {}", e))?;

        // Start the stream
        stream
            .play()
            .map_err(|e| format!("Failed to start stream: {}", e))?;

        Ok(stream)
    }

    // Create an audio stream with F32 format and resampling
    fn create_stream_f32(
        &self,
        device: &cpal::Device,
        config: &cpal::StreamConfig,
        active_sender: Arc<Mutex<Option<mpsc::Sender<AudioStreamMessage>>>>,
        err_fn: impl FnMut(cpal::StreamError) + Send + 'static,
        resampler: Option<Arc<Mutex<SincFixedIn<f32>>>>,
        sample_buffer: Arc<Mutex<Vec<Vec<f32>>>>,
        channels: usize,
    ) -> Result<cpal::Stream, cpal::BuildStreamError> {
        device.build_input_stream(
            config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                // F32 samples are already in the right format, just deinterleave by channel
                let mut channel_data: Vec<Vec<f32>> = vec![Vec::new(); channels];
                for (i, &sample) in data.iter().enumerate() {
                    let channel = i % channels;
                    channel_data[channel].push(sample);
                }

                if let Some(ref resampler_arc) = resampler {
                    // Resampling path
                    let mut buffer = sample_buffer.lock().unwrap();
                    
                    // Accumulate samples
                    for ch in 0..channels {
                        buffer[ch].extend_from_slice(&channel_data[ch]);
                    }

                    // Process when we have enough samples
                    let mut resampler = resampler_arc.lock().unwrap();
                    let input_frames_needed = resampler.input_frames_next();
                    
                    while buffer[0].len() >= input_frames_needed {
                        // Extract chunk for resampling
                        let chunk: Vec<Vec<f32>> = buffer
                            .iter()
                            .map(|ch| ch[..input_frames_needed].to_vec())
                            .collect();

                        // Remove processed samples from buffer
                        for ch in 0..channels {
                            buffer[ch].drain(..input_frames_needed);
                        }

                        // Resample
                        match resampler.process(&chunk, None) {
                            Ok(resampled) => {
                                // Convert to i16 and interleave
                                let mut interleaved = Vec::new();
                                let num_frames = resampled[0].len();
                                
                                for i in 0..num_frames {
                                    for ch in 0..channels {
                                        // Convert f32 to i16
                                        let sample = (resampled[ch][i] * 32768.0).clamp(-32768.0, 32767.0) as i16;
                                        interleaved.push(sample);
                                    }
                                }

                                // Convert to bytes
                                let bytes: Vec<u8> = interleaved
                                    .iter()
                                    .flat_map(|sample| sample.to_le_bytes().to_vec())
                                    .collect();

                                // Send bytes
                                let message = AudioStreamMessage::Data(Bytes::from(bytes));
                                if let Some(tx) = &*active_sender.lock().unwrap() {
                                    let _ = tx.try_send(message);
                                }
                            }
                            Err(e) => {
                                tracing::error!("Resampling error: {}", e);
                            }
                        }
                    }
                } else {
                    // No resampling needed - direct conversion to i16
                    // Interleave channels back together
                    let mut interleaved = Vec::new();
                    let num_frames = channel_data[0].len();
                    
                    for i in 0..num_frames {
                        for ch in 0..channels {
                            // Convert f32 to i16
                            let sample = (channel_data[ch][i] * 32768.0).clamp(-32768.0, 32767.0) as i16;
                            interleaved.push(sample);
                        }
                    }

                    // Convert to bytes
                    let bytes: Vec<u8> = interleaved
                        .iter()
                        .flat_map(|sample| sample.to_le_bytes().to_vec())
                        .collect();

                    // Send bytes
                    let message = AudioStreamMessage::Data(Bytes::from(bytes));
                    if let Some(tx) = &*active_sender.lock().unwrap() {
                        let _ = tx.try_send(message);
                    }
                }
            },
            err_fn,
            None,
        )
    }

    // Create an audio stream with i16 format and resampling
    fn create_stream_i16(
        &self,
        device: &cpal::Device,
        config: &cpal::StreamConfig,
        active_sender: Arc<Mutex<Option<mpsc::Sender<AudioStreamMessage>>>>,
        err_fn: impl FnMut(cpal::StreamError) + Send + 'static,
        resampler: Option<Arc<Mutex<SincFixedIn<f32>>>>,
        sample_buffer: Arc<Mutex<Vec<Vec<f32>>>>,
        channels: usize,
    ) -> Result<cpal::Stream, cpal::BuildStreamError> {
        device.build_input_stream(
            config,
            move |data: &[i16], _: &cpal::InputCallbackInfo| {
                // Convert i16 samples to f32 and deinterleave by channel
                let mut channel_data: Vec<Vec<f32>> = vec![Vec::new(); channels];
                for (i, sample) in data.iter().enumerate() {
                    let channel = i % channels;
                    // Normalize i16 to f32 range [-1.0, 1.0]
                    let normalized = *sample as f32 / 32768.0;
                    channel_data[channel].push(normalized);
                }

                if let Some(ref resampler_arc) = resampler {
                    // Resampling path
                    let mut buffer = sample_buffer.lock().unwrap();
                    
                    // Accumulate samples
                    for ch in 0..channels {
                        buffer[ch].extend_from_slice(&channel_data[ch]);
                    }

                    // Process when we have enough samples
                    let mut resampler = resampler_arc.lock().unwrap();
                    let input_frames_needed = resampler.input_frames_next();
                    
                    while buffer[0].len() >= input_frames_needed {
                        // Extract chunk for resampling
                        let chunk: Vec<Vec<f32>> = buffer
                            .iter()
                            .map(|ch| ch[..input_frames_needed].to_vec())
                            .collect();

                        // Remove processed samples from buffer
                        for ch in 0..channels {
                            buffer[ch].drain(..input_frames_needed);
                        }

                        // Resample
                        match resampler.process(&chunk, None) {
                            Ok(resampled) => {
                                // Convert back to i16 and interleave
                                let mut interleaved = Vec::new();
                                let num_frames = resampled[0].len();
                                
                                for i in 0..num_frames {
                                    for ch in 0..channels {
                                        // Convert f32 back to i16
                                        let sample = (resampled[ch][i] * 32768.0).clamp(-32768.0, 32767.0) as i16;
                                        interleaved.push(sample);
                                    }
                                }

                                // Convert to bytes
                                let bytes: Vec<u8> = interleaved
                                    .iter()
                                    .flat_map(|sample| sample.to_le_bytes().to_vec())
                                    .collect();

                                // Send bytes
                                let message = AudioStreamMessage::Data(Bytes::from(bytes));
                                if let Some(tx) = &*active_sender.lock().unwrap() {
                                    let _ = tx.try_send(message);
                                }
                            }
                            Err(e) => {
                                tracing::error!("Resampling error: {}", e);
                            }
                        }
                    }
                } else {
                    // No resampling needed - direct conversion
                    // Interleave channels back together
                    let mut interleaved = Vec::new();
                    let num_frames = channel_data[0].len();
                    
                    for i in 0..num_frames {
                        for ch in 0..channels {
                            // Convert f32 back to i16
                            let sample = (channel_data[ch][i] * 32768.0).clamp(-32768.0, 32767.0) as i16;
                            interleaved.push(sample);
                        }
                    }

                    // Convert to bytes
                    let bytes: Vec<u8> = interleaved
                        .iter()
                        .flat_map(|sample| sample.to_le_bytes().to_vec())
                        .collect();

                    // Send bytes
                    let message = AudioStreamMessage::Data(Bytes::from(bytes));
                    if let Some(tx) = &*active_sender.lock().unwrap() {
                        let _ = tx.try_send(message);
                    }
                }
            },
            err_fn,
            None,
        )
    }
}
