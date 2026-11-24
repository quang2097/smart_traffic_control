import assert from 'node:assert/strict';
import test from 'node:test';
import { cropFromPoints, pixelCrop, validResolution } from './vision-math.ts';

test('crop works in both drag directions and clamps to the video bounds', () => {
  assert.deepEqual(cropFromPoints({ x: .8, y: .7 }, { x: .2, y: .1 }), { x: .2, y: .1, width: .8 - .2, height: .7 - .1 });
  assert.deepEqual(cropFromPoints({ x: -.5, y: -.5 }, { x: 2, y: 2 }), { x: 0, y: 0, width: 1, height: 1 });
});
test('normalized crop maps exactly to video pixels without overflow', () => {
  assert.deepEqual(pixelCrop({ x: .25, y: .25, width: .5, height: .5 }, 1920, 1080), { x: 480, y: 270, width: 960, height: 540 });
  assert.deepEqual(pixelCrop({ x: 1, y: 1, width: 0, height: 0 }, 1920, 1080), { x: 1919, y: 1079, width: 1, height: 1 });
});
test('model resolution requires bounded integer dimensions', () => {
  assert.equal(validResolution(160, 96), true);
  for (const [width, height] of [[0, 224], [224, 2049], [224.5, 224], [NaN, 224]]) assert.equal(validResolution(width, height), false);
});
