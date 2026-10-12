export const storageErrors = Object.freeze({
  STORAGE_UNAVAILABLE: 'Storage unavailable',
  PATH_NOT_FOUND: 'Storage path does not exist',
  PERMISSION_DENIED: 'Storage access denied',
  IO_ERROR: 'Filesystem input/output error',
  MOUNT_DISCONNECTED: 'Storage mount disconnected',
  STALE_MOUNT: 'Storage mount is stale',
  NOT_DIRECTORY: 'Storage path is not a directory',
  INVALID_METRICS: 'Invalid filesystem measurements',
  MOUNT_NOT_FOUND: 'Storage mount information unavailable',
});

export function storageFailure(error) {
  const codes = { ENOENT: 'PATH_NOT_FOUND', EACCES: 'PERMISSION_DENIED', EPERM: 'PERMISSION_DENIED',
    EIO: 'IO_ERROR', ENOTCONN: 'MOUNT_DISCONNECTED', ESTALE: 'STALE_MOUNT', ENOTDIR: 'NOT_DIRECTORY' };
  const code = Object.hasOwn(codes, error?.code) ? codes[error.code]
    : Object.hasOwn(storageErrors, error?.code) ? error.code : 'STORAGE_UNAVAILABLE';
  return { code, error: storageErrors[code] };
}
