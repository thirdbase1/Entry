'use client';

/**
 * Ported 1:1 from components/file-icon-renderer.tsx.
 * Renders the appropriate file-type icon based on mimeType, or an image
 * thumbnail for image files. Uses @blocksuite/icons/rc for the icon set
 * (same as the original).
 */
import {
  FileIcon,
  FileIconCssIcon,
  FileIconCsvIcon,
  FileIconDocxIcon,
  FileIconHtmlIcon,
  FileIconJsIcon,
  FileIconJsonIcon,
  FileIconMdIcon,
  FileIconPdfIcon,
  FileIconPptxIcon,
  FileIconTxtIcon,
  FileIconXlsxIcon,
  FileIconXmlIcon,
} from '@blocksuite/icons/rc';
import { type ComponentType, useEffect, useState } from 'react';

import { useAuthStore } from '@/store/auth';

const presetsIcons: Record<string, ComponentType<{ className?: string }>> = {
  'application/pdf': FileIconPdfIcon,
  'text/markdown': FileIconMdIcon,
  'text/plain': FileIconTxtIcon,
  'text/csv': FileIconCsvIcon,
  'text/html': FileIconHtmlIcon,
  'text/css': FileIconCssIcon,
  'text/javascript': FileIconJsIcon,
  'text/xml': FileIconXmlIcon,
  'text/json': FileIconJsonIcon,
  'application/msword': FileIconPdfIcon,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': FileIconDocxIcon,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': FileIconXlsxIcon,
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': FileIconPptxIcon,
};

export function FileIconRenderer({
  mimeType,
  blobId,
  blob,
  className,
}: {
  mimeType: string;
  blobId?: string;
  blob?: File;
  className?: string;
}) {
  const { user } = useAuthStore();
  const [imgUrl, setImgUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!mimeType.startsWith('image/')) return;
    if (!blobId && !blob) return;

    if (blobId && user?.id) {
      const url = `/api/copilot/blob/${user.id}/${blobId}`;
      setImgUrl(url);
    }
    if (blob) {
      const url = URL.createObjectURL(blob);
      setImgUrl(url);
      return () => {
        setImgUrl(null);
        URL.revokeObjectURL(url);
      };
    }
    return () => setImgUrl(null);
  }, [blob, blobId, mimeType, user?.id]);

  if (imgUrl) {
    return <img src={imgUrl} alt="file" className={className} />;
  }

  const Icon = presetsIcons[mimeType];
  if (Icon) {
    return <Icon className={className} />;
  }

  return <FileIcon className={className} />;
}
