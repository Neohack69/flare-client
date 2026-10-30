import { describe, expect, it } from 'vitest';

import {
  HIDDEN_ARG,
  isHiddenLaunch,
  loginItemArgs,
  shouldRevealOnSecondInstance,
} from './lifecycle';

describe('hidden launch / single-instance (T123)', () => {
  it('распознаёт --hidden', () => {
    expect(isHiddenLaunch(['electron.exe', 'app', HIDDEN_ARG])).toBe(true);
    expect(isHiddenLaunch(['electron.exe', 'app'])).toBe(false);
  });

  it('второй --hidden-экземпляр не показывает окно', () => {
    expect(shouldRevealOnSecondInstance(['exe', HIDDEN_ARG])).toBe(false);
    expect(shouldRevealOnSecondInstance(['exe'])).toBe(true);
  });

  it('login item всегда стартует скрыто', () => {
    expect(loginItemArgs()).toEqual([HIDDEN_ARG]);
  });
});
