export interface ConfigResponse {
  bucket: string;
  prefix: string;
  port: number;
}

export interface FileEntry {
  key: string;
  name: string;
  size: number;
  last_modified: string;
  is_dir: boolean;
}

export interface FolderEntry {
  prefix: string;
  name: string;
}

export interface FilesResponse {
  files: FileEntry[];
  folders: FolderEntry[];
  next_marker: string | null;
  truncated: boolean;
}

export interface SearchResponse {
  results: FileEntry[];
}

export interface NoteEntry {
  key: string;
  name: string;
  folder: string;
  size: number;
  last_modified: string;
}

export interface NotesResponse {
  prefix: string;
  notes: NoteEntry[];
}

export interface UploadResponse {
  key: string;
  size: number;
}

export type EditableExtension = 'md' | 'txt';

export interface EditableFileResponse {
  key: string;
  content: string;
  etag: string;
  size: number;
  content_type: string;
}

export interface FileWriteResponse {
  key: string;
  etag: string;
  size: number;
}

export interface CreateFileRequest {
  prefix: string;
  name: string;
  extension: EditableExtension;
  content?: string;
}

export interface UpdateFileRequest {
  key: string;
  content: string;
  expected_etag: string;
  force?: boolean;
}

export interface UploadInitResponse {
  upload_id: string;
  key: string;
}

export interface UploadPartResponse {
  part_number: number;
  etag: string;
}

export interface UploadPart {
  part_number: number;
  etag: string;
}

export interface OkResponse {
  ok: true;
}

export interface DeleteFolderResponse {
  deleted: number;
}

export interface FolderResponse {
  prefix: string;
}

export interface TransferResponse {
  old_key: string;
  new_key: string;
}

export interface DriveItem {
  kind: 'file' | 'folder';
  key: string;
  name: string;
  size: number;
  lastModified: string;
  isDir: boolean;
}

export type SortField = 'name' | 'size' | 'last_modified';
export type SortDirection = 'asc' | 'desc';
export type ViewMode = 'list' | 'grid';

export function fileToDriveItem(file: FileEntry): DriveItem {
  return {
    kind: file.is_dir ? 'folder' : 'file',
    key: file.key,
    name: file.name,
    size: file.size,
    lastModified: file.last_modified,
    isDir: file.is_dir,
  };
}

export function folderToDriveItem(folder: FolderEntry): DriveItem {
  return {
    kind: 'folder',
    key: folder.prefix,
    name: folder.name,
    size: 0,
    lastModified: '',
    isDir: true,
  };
}
