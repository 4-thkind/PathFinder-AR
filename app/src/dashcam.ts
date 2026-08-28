/**
 * Rolling dashcam / digital black box.
 *
 * MediaRecorder emits timesliced chunks which are kept in a bounded in-memory
 * ring. Nothing touches disk until an incident is flagged, so a normal ride
 * leaves no footage behind - that is both the privacy story and the storage
 * story.
 */
const SLICE_MS = 2000;

export interface SavedClip {
  id: number;
  at: number;
  seconds: number;
  blob: Blob;
  lat?: number;
  lon?: number;
}

export class Dashcam {
  private recorder?: MediaRecorder;
  private chunks: Blob[] = [];
  private mimeType = "";
  /** Rolling window length in seconds. */
  bufferSeconds = 180;
  clips: SavedClip[] = [];

  get recording(): boolean {
    return this.recorder?.state === "recording";
  }

  get bufferedSeconds(): number {
    return (this.chunks.length * SLICE_MS) / 1000;
  }

  start(stream: MediaStream): void {
    if (this.recording) return;
    this.mimeType = ["video/mp4", "video/webm;codecs=vp9", "video/webm"].find((t) =>
      MediaRecorder.isTypeSupported(t),
    ) ?? "";
    this.recorder = new MediaRecorder(stream, this.mimeType ? { mimeType: this.mimeType } : undefined);
    this.recorder.ondataavailable = (event) => {
      if (!event.data.size) return;
      this.chunks.push(event.data);
      const maxChunks = Math.ceil((this.bufferSeconds * 1000) / SLICE_MS);
      if (this.chunks.length > maxChunks) this.chunks.splice(0, this.chunks.length - maxChunks);
    };
    this.recorder.start(SLICE_MS);
  }

  stop(): void {
    if (this.recording) this.recorder!.stop();
    this.chunks = [];
  }

  /** Freeze the current rolling window into a permanent local clip. */
  saveIncident(position?: GeolocationPosition): SavedClip | undefined {
    if (!this.chunks.length) return undefined;
    const clip: SavedClip = {
      id: Date.now(),
      at: Date.now(),
      seconds: Math.round(this.bufferedSeconds),
      blob: new Blob(this.chunks, { type: this.mimeType || "video/webm" }),
      lat: position?.coords.latitude,
      lon: position?.coords.longitude,
    };
    this.clips.unshift(clip);
    return clip;
  }
}
