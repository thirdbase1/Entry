'use client';

/**
 * Ported 1:1 from components/doc-panel/presentation-mode.tsx.
 * Paginated fullscreen presentation of a doc's note blocks, with keyboard
 * navigation, auto-hiding toolbar, and native Fullscreen API integration.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Text, type Store } from '@blocksuite/affine/store';
import { replaceIdMiddleware } from '@blocksuite/affine-shared/adapters';
import { DocEditor } from '@/components/doc-editor';

interface PresentationModeProps {
  doc: Store;
  onClose: () => void;
}

// biome-ignore lint: matches original's loose NoteBlockModel duck-typing without pulling in the full Entry block-model type
type NoteBlockModel = any;

function NoteBlockContent({ note, doc }: { note: NoteBlockModel; doc: Store }) {
  const [noteDoc, setNoteDoc] = useState<Store | null>(null);

  useEffect(() => {
    setNoteDoc(null);
    try {
      const _doc = (doc as any).workspace.createDoc();
      const transformer = (doc as any).getTransformer([
        replaceIdMiddleware((doc as any).workspace.idGenerator),
      ]);
      const blockSnapshot = transformer.blockToSnapshot(note);
      if (!blockSnapshot) {
        console.error('Failed to create snapshot from note');
        return;
      }
      const linkedDoc = _doc.getStore();
      linkedDoc.load(() => {
        const rootId = linkedDoc.addBlock('affine:page', { title: new Text('') });
        transformer.snapshotToBlock(blockSnapshot, linkedDoc, rootId).catch(console.error);
      });
      setNoteDoc(linkedDoc);
    } catch (error) {
      console.error('Error creating note doc:', error);
    }
  }, [note, doc]);

  if (!noteDoc) {
    return (
      <div className="w-full h-full flex items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  return (
    <div className="w-full h-full">
      <DocEditor doc={noteDoc} readonly />
    </div>
  );
}

export function PresentationMode({ doc, onClose }: PresentationModeProps) {
  const title = (doc as any).meta?.title;
  const [currentSlide, setCurrentSlide] = useState(0);
  const [noteBlocks, setNoteBlocks] = useState<NoteBlockModel[]>([]);
  const [showToolbars, setShowToolbars] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const getNoteBlocks = useCallback(() => {
    const root = (doc as any)?.root;
    if (!root) return [];
    return root.children.filter(
      (child: any) => child.flavour === 'affine:note' && child.props?.displayMode !== 'EdgelessOnly'
    ) as NoteBlockModel[];
  }, [doc]);

  useEffect(() => {
    setNoteBlocks(getNoteBlocks());
  }, [getNoteBlocks]);

  useEffect(() => {
    const handleMouseMove = () => {
      setShowToolbars(true);
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = setTimeout(() => setShowToolbars(false), 2000);
    };
    document.addEventListener('mousemove', handleMouseMove);
    hideTimeoutRef.current = setTimeout(() => setShowToolbars(false), 2000);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    };
  }, []);

  const exitPresentation = useCallback(async () => {
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch (error) {
        console.warn('Failed to exit fullscreen:', error);
      }
    }
    onClose();
  }, [onClose]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          setCurrentSlide(s => Math.max(0, s - 1));
          break;
        case 'ArrowRight':
        case ' ':
          e.preventDefault();
          setCurrentSlide(s => Math.min(noteBlocks.length - 1, s + 1));
          break;
        case 'Escape':
          e.preventDefault();
          exitPresentation();
          break;
        case 'Home':
          e.preventDefault();
          setCurrentSlide(0);
          break;
        case 'End':
          e.preventDefault();
          setCurrentSlide(noteBlocks.length - 1);
          break;
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [noteBlocks.length, exitPresentation]);

  useEffect(() => {
    const enterFullscreen = async () => {
      if (containerRef.current && !document.fullscreenElement) {
        try {
          await containerRef.current.requestFullscreen();
        } catch (error) {
          console.warn('Unable to enter fullscreen mode:', error);
        }
      }
    };
    enterFullscreen();
    const handleFullscreenChange = () => {
      if (!document.fullscreenElement) onClose();
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, [onClose]);

  const nextSlide = () => setCurrentSlide(s => Math.min(noteBlocks.length - 1, s + 1));
  const previousSlide = () => setCurrentSlide(s => Math.max(0, s - 1));

  if (noteBlocks.length === 0) {
    return (
      <div ref={containerRef} className="fixed inset-0 bg-background text-foreground flex items-center justify-center z-50">
        <div className="text-center">
          <h2 className="text-2xl mb-4">No content to present</h2>
          <p className="text-muted-foreground mb-6">No note blocks found in the document for presentation</p>
          <button onClick={exitPresentation} className="px-6 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90">
            Close Presentation
          </button>
        </div>
      </div>
    );
  }

  const currentNote = noteBlocks[currentSlide];
  const getCurrentTitle = () => (currentSlide === 0 ? title : currentNote?.props?.title || title);

  return (
    <div ref={containerRef} className="fixed inset-0 bg-background z-50 flex flex-col">
      <div
        className={`absolute top-4 left-4 right-4 z-10 flex items-center justify-between backdrop-blur-sm bg-card/70 border border-border rounded-lg px-4 py-2 shadow-sm transition-opacity duration-300 ${
          showToolbars ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-semibold text-foreground truncate">{getCurrentTitle()}</h1>
          <div className="text-sm text-muted-foreground">
            {currentSlide + 1} / {noteBlocks.length}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={previousSlide}
            disabled={currentSlide === 0}
            className="p-2 rounded hover:bg-accent transition-colors disabled:opacity-50 text-muted-foreground"
            aria-label="Previous slide"
          >
            ←
          </button>
          <button
            onClick={nextSlide}
            disabled={currentSlide === noteBlocks.length - 1}
            className="p-2 rounded hover:bg-accent transition-colors disabled:opacity-50 text-muted-foreground"
            aria-label="Next slide"
          >
            →
          </button>
          <button onClick={exitPresentation} className="p-2 rounded hover:bg-accent transition-colors text-muted-foreground" aria-label="Close presentation">
            ✕
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        <div className="w-full h-full">
          {currentNote && (
            <div className="h-full w-full overflow-auto">
              <div className="p-16">
                <NoteBlockContent note={currentNote} doc={doc} />
              </div>
            </div>
          )}
        </div>
      </div>

      <div
        className={`absolute bottom-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 transition-opacity duration-300 ${
          showToolbars ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        {noteBlocks.map((_, i) => (
          <button
            key={i}
            onClick={() => setCurrentSlide(i)}
            className={`w-2 h-2 rounded-full transition-colors ${i === currentSlide ? 'bg-primary' : 'bg-muted-foreground/40'}`}
            aria-label={`Go to slide ${i + 1}`}
          />
        ))}
      </div>
    </div>
  );
}
