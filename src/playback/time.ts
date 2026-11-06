// performance.timeOrigin + performance.now() can lag wall time after sleep
// on macOS. Documents created on opposite sides of sleep then disagree about
// epoch timestamps. Sample the current offset at both ends of the message;
// keep the playback clock itself monotonic once the timestamp is local.
export function playbackEpochTime(localTime: number): number {
  return Date.now() + (localTime - performance.now());
}

export function playbackLocalTime(epochTime: number): number {
  return performance.now() + (epochTime - Date.now());
}
