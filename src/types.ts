export type Version = 3 | 4 | 5 | 2010;

export interface Dico<T> {
	[i: number]: T | undefined;
	[i: string]: T | undefined;
}
