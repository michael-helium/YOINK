export const POINTS: Record<string, number> = {
  "_": 0,
  E:1,A:1,O:1,T:1,I:1,N:1,R:1,S:1,L:1,U:1,
  D:2,G:2,
  C:3,M:3,B:3,P:3,
  H:4,F:4,W:4,Y:4,V:4,
  K:5,J:8,X:8,Q:10,Z:10
};

export function scoreWord(word: string): number {
  const base = [...word].reduce((s,ch)=>s+(POINTS[ch]??0),0);
  const bonus = 1 + 0.05 * word.length;
  return Math.round(base * bonus);
}
