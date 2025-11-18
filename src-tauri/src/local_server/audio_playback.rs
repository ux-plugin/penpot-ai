use base64::engine::general_purpose;
use base64::Engine as _;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tokio::sync::{mpsc, oneshot};

// Commands for the playback manager
pub enum PlaybackCommand {
    Play {
        audio_data: String, // base64-encoded PCM audio
        response_tx: oneshot::Sender<Result<(), String>>,
        playback_ended_tx: mpsc::Sender<PlaybackEvent>,
    },
    Stop,
}

// Events sent back during playback lifecycle
#[derive(Debug, Clone)]
pub enum PlaybackEvent {
    PlaybackEnded,
    PlaybackError(String),
}

// Handle to control active playback
pub struct PlaybackHandle {
    stop_flag: Arc<AtomicBool>,
}

impl PlaybackHandle {
    pub fn new(stop_flag: Arc<AtomicBool>) -> Self {
        Self { stop_flag }
    }

    pub fn stop(&self) {
        self.stop_flag.store(true, Ordering::SeqCst);
        tracing::debug!("Playback handle: Stop flag set");
    }
}

// Audio playback manager that handles playback
pub struct AudioPlaybackManager {
    command_rx: mpsc::Receiver<PlaybackCommand>,
    active_stream: Mutex<Option<cpal::Stream>>,
    is_playing: AtomicBool,
}

impl AudioPlaybackManager {
    /// Create a new audio playback manager
    pub fn new(command_rx: mpsc::Receiver<PlaybackCommand>) -> Self {
        Self {
            command_rx,
            active_stream: Mutex::new(None),
            is_playing: AtomicBool::new(false),
        }
    }

    /// Run the audio playback manager
    pub async fn run(&mut self) {
        tracing::info!("AudioPlaybackManager started");

        while let Some(command) = self.command_rx.recv().await {
            match command {
                PlaybackCommand::Play {
                    audio_data,
                    response_tx,
                    playback_ended_tx,
                } => {
                    tracing::debug!("Playback manager: Received play command");

                    // Stop any existing playback first (only one playback at a time)
                    self.cleanup_state();

                    // Set playing flag
                    if self
                        .is_playing
                        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                        .is_err()
                    {
                        tracing::warn!("Playback manager: Playback already in progress");
                        let _ = response_tx.send(Err("Playback already in progress".to_string()));
                        continue;
                    }

                    // Decode base64 audio data
                    let pcm_bytes = match general_purpose::STANDARD.decode(&audio_data) {
                        Ok(bytes) => bytes,
                        Err(e) => {
                            tracing::error!("Playback manager: Failed to decode base64: {}", e);
                            self.is_playing.store(false, Ordering::SeqCst);
                            let _ = response_tx.send(Err(format!("Invalid base64 data: {}", e)));
                            let _ = playback_ended_tx
                                .send(PlaybackEvent::PlaybackError(format!(
                                    "Invalid base64 data: {}",
                                    e
                                )))
                                .await;
                            continue;
                        }
                    };

                    // Convert bytes to i16 samples
                    if pcm_bytes.len() % 2 != 0 {
                        tracing::error!("Playback manager: Invalid PCM data length");
                        self.is_playing.store(false, Ordering::SeqCst);
                        let _ = response_tx.send(Err("Invalid PCM data length".to_string()));
                        let _ = playback_ended_tx
                            .send(PlaybackEvent::PlaybackError(
                                "Invalid PCM data length".to_string(),
                            ))
                            .await;
                        continue;
                    }

                    let samples: Vec<i16> = pcm_bytes
                        .chunks_exact(2)
                        .map(|chunk| i16::from_le_bytes([chunk[0], chunk[1]]))
                        .collect();

                    tracing::debug!(
                        "Playback manager: Decoded {} samples ({} bytes)",
                        samples.len(),
                        pcm_bytes.len()
                    );

                    // Start playback (samples are at 16000Hz and will be resampled)
                    match self.play_audio(samples, playback_ended_tx.clone()).await {
                        Ok(stream) => {
                            let mut stream_lock = self.active_stream.lock().unwrap();
                            *stream_lock = Some(stream);
                            tracing::info!("Playback manager: Playback started successfully");
                            let _ = response_tx.send(Ok(()));
                        }
                        Err(e) => {
                            tracing::error!("Playback manager: Failed to start playback: {}", e);
                            self.is_playing.store(false, Ordering::SeqCst);
                            let _ = response_tx.send(Err(e.clone()));
                            let _ = playback_ended_tx
                                .send(PlaybackEvent::PlaybackError(e))
                                .await;
                        }
                    }
                }
                PlaybackCommand::Stop => {
                    tracing::debug!("Playback manager: Stopping playback");
                    self.cleanup_state();
                    tracing::debug!("Playback manager: Playback stopped and state cleaned up");
                }
            }
        }

        tracing::info!("AudioPlaybackManager stopped");
    }

    /// Cleanup playback state
    fn cleanup_state(&self) {
        // Stop stream
        let mut stream = self.active_stream.lock().unwrap();
        *stream = None;

        // Reset playing flag
        self.is_playing.store(false, Ordering::SeqCst);
    }

    /// Play audio samples through system output
    async fn play_audio(
        &self,
        samples: Vec<i16>,
        playback_ended_tx: mpsc::Sender<PlaybackEvent>,
    ) -> Result<cpal::Stream, String> {
        // Get default host
        let host = cpal::default_host();

        // Get default output device
        let device = host
            .default_output_device()
            .ok_or_else(|| "No output device available".to_string())?;

        tracing::info!(
            "Using output device: {}",
            device.name().unwrap_or_else(|_| "Unknown".to_string())
        );

        // Get default output config
        let default_config = device
            .default_output_config()
            .map_err(|e| format!("Failed to get default output config: {}", e))?;

        let device_sample_rate = default_config.sample_rate().0;
        let channels = default_config.channels() as usize;
        let sample_format = default_config.sample_format();

        tracing::debug!(
            "Device output config: {}Hz, channels: {}, format: {:?}",
            device_sample_rate,
            channels,
            sample_format
        );

        // Incoming audio is at 16000Hz MONO (from recording/resampling)
        let input_sample_rate = 16000u32;
        let input_channels = 1; // Backend sends mono audio
        
        // Resample and convert to device format if needed
        let resampled_samples = if input_sample_rate != device_sample_rate || input_channels != channels {
            tracing::debug!(
                "Resampling audio from {}Hz ({}ch) to {}Hz ({}ch)",
                input_sample_rate,
                input_channels,
                device_sample_rate,
                channels
            );
            
            match self.resample_audio(&samples, input_sample_rate, device_sample_rate, input_channels, channels) {
                Ok(resampled) => {
                    tracing::debug!(
                        "Resampled {} samples to {} samples",
                        samples.len(),
                        resampled.len()
                    );
                    resampled
                }
                Err(e) => {
                    tracing::error!("Failed to resample audio: {}", e);
                    return Err(format!("Failed to resample audio: {}", e));
                }
            }
        } else {
            tracing::debug!("No resampling needed");
            samples
        };

        let config = cpal::StreamConfig {
            channels: default_config.channels(),
            sample_rate: default_config.sample_rate(),
            buffer_size: cpal::BufferSize::Default,
        };

        // Wrap resampled samples in Arc for sharing across threads
        let samples = Arc::new(resampled_samples);
        let sample_index = Arc::new(Mutex::new(0_usize));
        let stop_flag = Arc::new(AtomicBool::new(false));

        // Clone for error callback
        let playback_ended_tx_err = playback_ended_tx.clone();
        let is_playing = Arc::new(AtomicBool::new(true));
        let is_playing_clone = Arc::clone(&is_playing);

        let err_fn = move |err: cpal::StreamError| {
            tracing::error!("Audio playback error occurred: {}", err);

            // Send error event if we haven't already handled it
            if is_playing_clone.swap(false, Ordering::SeqCst) {
                let error_msg = format!("Audio playback error: {}", err);
                let _ = playback_ended_tx_err.try_send(PlaybackEvent::PlaybackError(error_msg));
            }
        };

        // Create the output stream based on format
        let stream = match sample_format {
            cpal::SampleFormat::F32 => self.create_output_stream_f32(
                &device,
                &config,
                samples,
                sample_index,
                stop_flag.clone(),
                playback_ended_tx,
                channels,
            ),
            cpal::SampleFormat::I16 => self.create_output_stream_i16(
                &device,
                &config,
                samples,
                sample_index,
                stop_flag.clone(),
                playback_ended_tx,
                channels,
            ),
            _ => {
                return Err(format!(
                    "Unsupported sample format: {:?}. Only F32 and I16 are supported.",
                    sample_format
                ));
            }
        }
        .map_err(|e| format!("Failed to build output stream: {}", e))?;

        // Start the stream
        stream
            .play()
            .map_err(|e| format!("Failed to start playback stream: {}", e))?;

        Ok(stream)
    }

    /// Create an output stream with F32 format
    fn create_output_stream_f32(
        &self,
        device: &cpal::Device,
        config: &cpal::StreamConfig,
        samples: Arc<Vec<i16>>,
        sample_index: Arc<Mutex<usize>>,
        stop_flag: Arc<AtomicBool>,
        playback_ended_tx: mpsc::Sender<PlaybackEvent>,
        channels: usize,
    ) -> Result<cpal::Stream, cpal::BuildStreamError> {
        let playback_ended = Arc::new(AtomicBool::new(false));
        let playback_ended_clone = Arc::clone(&playback_ended);

        device.build_output_stream(
            config,
            move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                let mut index = sample_index.lock().unwrap();

                for frame in data.chunks_mut(channels) {
                    // Check if we should stop
                    if stop_flag.load(Ordering::SeqCst) {
                        // Fill remaining buffer with silence
                        for sample in frame.iter_mut() {
                            *sample = 0.0;
                        }
                        continue;
                    }

                    // Check if we've reached the end
                    if *index >= samples.len() {
                        // Fill with silence
                        for sample in frame.iter_mut() {
                            *sample = 0.0;
                        }

                        // Send playback ended event (only once)
                        if !playback_ended_clone.swap(true, Ordering::SeqCst) {
                            let _ = playback_ended_tx.try_send(PlaybackEvent::PlaybackEnded);
                        }
                        continue;
                    }

                    // Fill the frame with samples
                    for sample in frame.iter_mut() {
                        if *index < samples.len() {
                            // Convert i16 to f32 [-1.0, 1.0]
                            *sample = samples[*index] as f32 / 32768.0;
                            *index += 1;
                        } else {
                            *sample = 0.0;
                        }
                    }
                }
            },
            move |err| {
                tracing::error!("Output stream error: {}", err);
            },
            None,
        )
    }

    /// Create an output stream with I16 format
    fn create_output_stream_i16(
        &self,
        device: &cpal::Device,
        config: &cpal::StreamConfig,
        samples: Arc<Vec<i16>>,
        sample_index: Arc<Mutex<usize>>,
        stop_flag: Arc<AtomicBool>,
        playback_ended_tx: mpsc::Sender<PlaybackEvent>,
        channels: usize,
    ) -> Result<cpal::Stream, cpal::BuildStreamError> {
        let playback_ended = Arc::new(AtomicBool::new(false));
        let playback_ended_clone = Arc::clone(&playback_ended);

        device.build_output_stream(
            config,
            move |data: &mut [i16], _: &cpal::OutputCallbackInfo| {
                let mut index = sample_index.lock().unwrap();

                for frame in data.chunks_mut(channels) {
                    // Check if we should stop
                    if stop_flag.load(Ordering::SeqCst) {
                        // Fill remaining buffer with silence
                        for sample in frame.iter_mut() {
                            *sample = 0;
                        }
                        continue;
                    }

                    // Check if we've reached the end
                    if *index >= samples.len() {
                        // Fill with silence
                        for sample in frame.iter_mut() {
                            *sample = 0;
                        }

                        // Send playback ended event (only once)
                        if !playback_ended_clone.swap(true, Ordering::SeqCst) {
                            let _ = playback_ended_tx.try_send(PlaybackEvent::PlaybackEnded);
                        }
                        continue;
                    }

                    // Fill the frame with samples
                    for sample in frame.iter_mut() {
                        if *index < samples.len() {
                            *sample = samples[*index];
                            *index += 1;
                        } else {
                            *sample = 0;
                        }
                    }
                }
            },
            move |err| {
                tracing::error!("Output stream error: {}", err);
            },
            None,
        )
    }

    /// Resample audio from one sample rate to another and convert channel count
    fn resample_audio(
        &self,
        samples: &[i16],
        input_rate: u32,
        output_rate: u32,
        input_channels: usize,
        output_channels: usize,
    ) -> Result<Vec<i16>, String> {
        // Deinterleave samples by input channel
        let num_frames = samples.len() / input_channels;
        let mut channel_data: Vec<Vec<f32>> = vec![Vec::with_capacity(num_frames); input_channels];
        
        for (i, &sample) in samples.iter().enumerate() {
            let channel = i % input_channels;
            // Convert i16 to f32 [-1.0, 1.0]
            let normalized = sample as f32 / 32768.0;
            channel_data[channel].push(normalized);
        }

        // Step 1: Resample at the input channel count
        let resampled = if input_rate != output_rate {
            let params = SincInterpolationParameters {
                sinc_len: 256,
                f_cutoff: 0.95,
                interpolation: SincInterpolationType::Linear,
                oversampling_factor: 256,
                window: WindowFunction::BlackmanHarris2,
            };

            let mut resampler = SincFixedIn::<f32>::new(
                output_rate as f64 / input_rate as f64,
                2.0,
                params,
                num_frames,
                input_channels,
            )
            .map_err(|e| format!("Failed to create resampler: {}", e))?;

            resampler
                .process(&channel_data, None)
                .map_err(|e| format!("Resampling failed: {}", e))?
        } else {
            channel_data
        };

        // Step 2: Convert channel count if needed (e.g., mono to stereo)
        let output_frames = resampled[0].len();
        let mut output = Vec::with_capacity(output_frames * output_channels);
        
        if input_channels == 1 && output_channels == 2 {
            // Mono to stereo: duplicate the mono channel to both left and right
            for i in 0..output_frames {
                let sample = (resampled[0][i] * 32768.0).clamp(-32768.0, 32767.0) as i16;
                output.push(sample); // Left channel
                output.push(sample); // Right channel
            }
        } else if input_channels == output_channels {
            // Same channel count: just interleave
            for i in 0..output_frames {
                for ch in 0..output_channels {
                    let sample = (resampled[ch][i] * 32768.0).clamp(-32768.0, 32767.0) as i16;
                    output.push(sample);
                }
            }
        } else {
            // Other conversions not yet implemented
            return Err(format!(
                "Unsupported channel conversion: {} -> {}",
                input_channels, output_channels
            ));
        }

        Ok(output)
    }
}
