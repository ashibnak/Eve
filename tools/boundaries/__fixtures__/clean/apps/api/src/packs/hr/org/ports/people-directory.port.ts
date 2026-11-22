export interface PeopleDirectoryPort {
  get(id: string): { id: string };
}
