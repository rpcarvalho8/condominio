export type ContentUpload = {
  id: string;
  tenantId: string;
  contentHash: string;
  filename: string;
  byteSize: number;
  createdAt: Date;
};

export type RegisterUploadInput = {
  tenantId: string;
  contentHash: string;
  filename: string;
  byteSize: number;
};
