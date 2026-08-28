import type { Alert } from "./hazards.ts";

/**
 * Audio warnings. A rider's eyes belong on the road, so sound carries the
 * warning and the screen only confirms it.
 *
 * A short chime fires immediately (it is the part that actually buys reaction
 * time); speech follows for anything severe enough to be worth a sentence.
 */
export class AlertVoice {
  private ctx?: AudioContext;
  enabled = true;
  speech = true;

  /** Must be called from a user gesture - browsers block audio otherwise. */
  unlock(): void {
    this.ctx ??= new AudioContext();
    void this.ctx.resume();
  }

  private chime(severity: number): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    // higher and louder the more severe, so urgency is audible without words
    osc.frequency.setValueAtTime(660 + 340 * Math.min(1, severity), now);
    osc.frequency.exponentialRampToValueAtTime(440, now + 0.18);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.25, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 0.36);
  }

  announce(alert: Alert): void {
    if (!this.enabled) return;
    this.chime(alert.severity);
    if (!this.speech || alert.severity < 0.5 || !("speechSynthesis" in window)) return;
    const utterance = new SpeechSynthesisUtterance(alert.spoken);
    utterance.rate = 1.15;
    utterance.volume = 1;
    speechSynthesis.cancel(); // a stale announcement is worse than none
    speechSynthesis.speak(utterance);
  }

  say(text: string): void {
    if (!this.enabled || !this.speech || !("speechSynthesis" in window)) return;
    speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }
}
