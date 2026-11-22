import { one } from './one';

export const two = (): number => (Math.random() > 2 ? one() : 0);
