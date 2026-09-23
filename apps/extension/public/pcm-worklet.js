// Glance voice capture: hands each block of microphone samples (already at the AudioContext's 16kHz) to the offscreen
// document, which converts them to 16-bit PCM and streams them to the Glance API. Loaded by lib/voiceWorker.ts.
class GlancePcm extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("glance-pcm", GlancePcm);
