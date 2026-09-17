import { Player } from 'node-playsound';

const player = new Player();
try {
  const playback = player.play(process.argv[2] ?? './sound.mp3');
  playback.pause();
  const inspect = async () => {
    const timing = await playback.getTiming();
    if (timing) console.log('Mixer position:', timing.position, 'Duration:', timing.duration ?? 'unknown');
    playback.resume();
  };
  await Promise.all([playback.finished, inspect()]);
} finally {
  await player.close();
}
