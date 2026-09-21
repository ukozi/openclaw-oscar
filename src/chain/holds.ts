export const MAX_HELD_PER_ROOM = 20;

export function mustHold(activeClass: string | null, incomingClass: string): boolean {
  return activeClass !== null && activeClass !== incomingClass;
}

type Held<T> = { holdClass: string; item: T };

export class HoldQueue<T> {
  private readonly rooms = new Map<string, Held<T>[]>();

  hold(roomKey: string, holdClass: string, item: T): boolean {
    const list = this.rooms.get(roomKey) ?? [];
    if (list.length >= MAX_HELD_PER_ROOM) return false;
    list.push({ holdClass, item });
    this.rooms.set(roomKey, list);
    return true;
  }

  next(roomKey: string): { holdClass: string; items: T[] } | null {
    const list = this.rooms.get(roomKey);
    const head = list?.[0];
    if (!list || !head) return null;
    let n = 0;
    while (list[n]?.holdClass === head.holdClass) n++;
    const items = list.splice(0, n).map((h) => h.item);
    if (list.length === 0) this.rooms.delete(roomKey);
    return { holdClass: head.holdClass, items };
  }

  size(roomKey: string): number {
    return this.rooms.get(roomKey)?.length ?? 0;
  }

  clear(): void {
    this.rooms.clear();
  }
}
