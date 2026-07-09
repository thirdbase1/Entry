/**
 * BlockSuite snapshot helper — ported from the original's
 * components/doc-composer/snapshot-helper.ts.
 *
 * Key adaptation: uses TestWorkspace from @blocksuite/affine/store/test
 * instead of the original's custom WorkspaceImpl/DocImpl/WorkspaceMetaImpl.
 * TestWorkspace implements the same Workspace interface with the same
 * createDoc/getDoc/meta API — the "Test only" warning is about its sync
 * engine (NoopDocSource/MemoryBlobSource), which is exactly what we want
 * for a local, non-collaborative doc viewer. The original's WorkspaceImpl
 * also used MemoryBlobSource by default.
 *
 * Note: `@blocksuite/affine-shared/adapters` has no `SimpleLayoutConverter`
 * export (checked directly — real `next build` caught this as a hard
 * import error, not assumed). Read `MarkdownAdapter`'s actual real source
 * (node_modules/@blocksuite/affine-shared/src/adapters/markdown/markdown.ts)
 * and its base class (node_modules/@blocksuite/store/src/adapter/base.ts):
 * `BaseAdapter.toDoc(payload)` already does exactly what the removed helper
 * was for — converts markdown -> DocSnapshot -> real Store via
 * `this.job.snapshotToDoc(snapshot)` (job = the Transformer passed to the
 * adapter's constructor) — so `markDownToDoc` below now calls that single
 * real method instead of hand-assembling a DocSnapshot.
 */

import { AffineSchemas } from '@blocksuite/affine/schemas';
import {
  type Store,
  Text,
  Transformer,
  nanoid,
  Schema,
  type Doc,
  type Workspace,
} from '@blocksuite/affine/store';
import { TestWorkspace } from '@blocksuite/affine/store/test';
import { MarkdownAdapter } from '@blocksuite/affine-shared/adapters';
import { StoreExtensionManager } from '@blocksuite/affine/ext-loader';
import { getInternalStoreExtensions } from '@blocksuite/affine/extensions/store';
import { Container } from '@blocksuite/global/di';
import * as Y from 'yjs';

// --- Store manager (singleton, same pattern as original) ---

let _storeManager: StoreExtensionManager | null = null;

function getStoreManager(): StoreExtensionManager {
  if (!_storeManager) {
    // NOTE: cast needed — npm can resolve two structurally-identical but
    // nominally-distinct copies of blocksuite's internal extension types
    // across sibling packages depending on hoisting, which TS then treats
    // as incompatible even though they're the same runtime class. Runtime
    // behavior is unaffected either way.
    _storeManager = new StoreExtensionManager(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [...getInternalStoreExtensions()] as any
    );
  }
  return _storeManager;
}

// --- Schema (singleton) ---

let _schema: Schema | null = null;

function getSchema(): Schema {
  if (!_schema) {
    _schema = new Schema();
    // Same zod-inference/type-duplication caveat as StoreExtensionManager above.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _schema.register([...AffineSchemas] as any);
  }
  return _schema;
}

// --- Temporary workspace factory ---

function getTempWorkspace(): Workspace {
  const collection = new TestWorkspace({
    id: nanoid(),
  });
  collection.meta.initialize();
  return collection;
}

// --- Transformer ---

function getTransformer() {
  const collection = getTempWorkspace();
  const schema = getSchema();
  const transformer = new Transformer({
    schema,
    blobCRUD: collection.blobSync,
    docCRUD: {
      create: (id: string) => {
        const doc = collection.createDoc(id);
        return doc.getStore({ id });
      },
      get: (id: string) => collection.getDoc(id)?.getStore({ id }) ?? null,
      delete: (id: string) => collection.removeDoc(id),
    },
  });
  return transformer;
}

// --- Markdown adapter ---

function getMarkdownAdapter(transformer = getTransformer()) {
  const extensions = getStoreManager().get('store');
  const container = new Container();
  extensions.forEach(ext => {
    ext.setup(container);
  });
  const mdAdapter = new MarkdownAdapter(transformer, container.provider());
  return mdAdapter;
}

// --- Public API ---

async function markDownToDoc(markdown: string): Promise<Store | undefined> {
  try {
    const transformer = getTransformer();
    const mdAdapter = getMarkdownAdapter(transformer);
    const doc = await mdAdapter.toDoc({ file: markdown });
    if (!doc) {
      console.error('Failed to convert markdown to doc');
    }
    return doc as Store | undefined;
  } catch (error) {
    console.error('Failed to convert markdown to doc:', error);
    return undefined;
  }
}

async function docToMarkdown(doc: Store): Promise<string> {
  const transformer = getTransformer();
  const mdAdapter = getMarkdownAdapter(transformer);
  const markdown = await mdAdapter.fromDoc(doc);
  if (!markdown) {
    console.error('Failed to convert doc to markdown');
  }
  return markdown?.file ?? '';
}

async function createStore(markdown?: string): Promise<Store | undefined> {
  if (markdown !== undefined) {
    return markDownToDoc(markdown);
  }

  const collection = getTempWorkspace();
  const doc = collection.createDoc();
  const store = doc.getStore();
  store.load(() => {
    const rootId = store.addBlock('affine:page', {
      title: new Text(''),
    });
    const noteId = store.addBlock('affine:note', {}, rootId);
    store.addBlock('affine:paragraph', {}, noteId);
  });
  store.resetHistory();
  return store;
}

export const snapshotHelper = {
  markDownToDoc,
  docToMarkdown,
  createStore,
};
