export interface IdGenerator {
  nextId(): string;
}

export class UuidV7Generator implements IdGenerator {
  nextId(): string {
    return Bun.randomUUIDv7();
  }
}
