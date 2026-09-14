import { Player } from '../dist/index.js';
import { resolve } from 'node:path';

const player = new Player();
try {
  const file = process.argv[2] ?? resolve('test/audio/tone.mp3');
  const playback = player.play(file, { volume: 0.1 });
  console.log(`Device playback: ${await playback.finished}`);
} finally {
  await player.close();
}
