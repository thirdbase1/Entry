'use client';

import { use, useEffect, useState } from 'react';

interface FileMeta {
  fileId: string;
  fileName: string;
  blobId: string;
  mimeType: string;
  size: number;
}

function isImage(mimeType: string) {
  return mimeType.startsWith('image/');
}

function FileViewer({ file }: { file: FileMeta }) {
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border h-15">
        <h2 className="text-xl font-semibold text-foreground truncate">{file.fileName}</h2>
        <a
          href={file.blobId}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center rounded-md text-sm font-medium border border-input bg-card hover:bg-accent transition-colors h-8 px-3"
        >
          Download
        </a>
      </div>
      <div className="flex-1 overflow-auto p-6 flex items-center justify-center">
        {isImage(file.mimeType) ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={file.blobId} alt={file.fileName} className="max-w-full max-h-full rounded-lg" />
        ) : (
          <div className="text-sm text-muted-foreground">
            {file.mimeType} · {(file.size / 1024).toFixed(1)} KB
          </div>
        )}
      </div>
    </div>
  );
}

export default function LibraryItemPage({ params }: { params: Promise<{ itemId: string }> }) {
  const { itemId } = use(params);
  const [kind, setKind] = useState<'file' | 'loading' | 'notfound'>('loading');
  const [file, setFile] = useState<FileMeta | null>(null);

  useEffect(() => {
    let cancelled = false;
    setKind('loading');

    (async () => {
      const fileRes = await fetch(`/api/copilot/files/${itemId}`);
      if (fileRes.ok) {
        const data = await fileRes.json();
        if (!cancelled) {
          setFile(data);
          setKind('file');
        }
        return;
      }
      if (!cancelled) setKind('notfound');
    })();

    return () => {
      cancelled = true;
    };
  }, [itemId]);

  if (kind === 'loading') {
    return <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Loading…</div>;
  }
  if (kind === 'notfound') {
    return <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Not found</div>;
  }
  return (
    <div className="flex-1 panel h-full">{file ? <FileViewer file={file} /> : null}</div>
  );
}
