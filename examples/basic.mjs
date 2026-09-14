import { play } from 'node-playsound';

if (!process.argv[2]) throw new Error('Usage: node basic.mjs ./sound.mp3');
try {
  await play(process.argv[2]).finished;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
