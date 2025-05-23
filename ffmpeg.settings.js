module.exports = {
  // Delay (in seconds) before music starts during Alex's intro
  introDelaySeconds: 3,

  // Volume controls
  voiceBoost: 2.5,         // Boost TTS (e.g., Alex) — 2.5 = +8dB
  musicReduction: 0.3,     // Reduce music — 0.3 = -10dB

  // Normalize music loudness
  normalizeMusic: true,    // Normalize to -16 LUFS

  // Future use: delay before Alex returns near end of music
  outroDelaySeconds: 8
};
