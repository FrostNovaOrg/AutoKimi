let revision = 0;

export function permissionStateRevision(): number {
  return revision;
}

export function notePermissionStateChanged(): void {
  revision += 1;
}
