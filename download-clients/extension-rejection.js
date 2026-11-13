export function rejectedExtension(record) {
  if (record?.status?.toLowerCase() !== 'completed'
    || !['importpending', 'importblocked', 'importfailed'].includes(record.trackedDownloadState?.toLowerCase())
    || record.trackedDownloadStatus?.toLowerCase() !== 'warning'
    || (record.errorMessage != null && record.errorMessage !== '')
    || !Array.isArray(record.statusMessages) || !record.statusMessages.length) return null;
  let extension;
  for (const group of record.statusMessages) {
    if (!Array.isArray(group?.messages) || !group.messages.length) return null;
    for (const message of group.messages) {
      const match = typeof message === 'string'
        && /^Invalid video file, unsupported extension: '((?:\.[^'\/\\\r\n]+)?)'$/.exec(message.trim());
      if (!match || (extension !== undefined && extension !== match[1])) return null;
      extension = match[1];
    }
  }
  return extension ?? null;
}
