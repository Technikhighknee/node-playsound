import { Player } from 'node-playsound';

// node examples/seeking.mjs ./track.mp3 80
const file = process.argv[2];
if (!file) throw new Error('Usage: node examples/seeking.mjs <audio-file> [seconds]');
const audio = new Player();
try {
  const playback = audio.play(file);
  playback.seek(Number(process.argv[3] ?? 80));
  // The same handle can seek again while active; finished observes all failures.
  console.log(await playback.finished);
} finally {
  await audio.close();
}
