import { Player } from 'node-playsound';

if (!process.argv[2]) throw new Error('Usage: node scoped.mjs ./sound.wav');
const audio = new Player();
try {
  const notification = audio.sound(process.argv[2], { volume: 0.3 });
  const first = notification.play();
  const second = notification.play({ signal: AbortSignal.timeout(1000) });
  console.log(await Promise.all([first.finished, second.finished]));
} finally {
  await audio.close();
}
