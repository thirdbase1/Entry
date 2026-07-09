/**
 * BlockSuite view extensions — ported from the original's
 * components/doc-composer/specs.ts.
 *
 * The ComposerViewExtensionProvider adds an HTML code block preview
 * (renders HTML inside code blocks marked as 'html'). The rest of the
 * view extensions come from getInternalViewExtensions() which includes
 * all standard block/inline/widget/fragment view extensions.
 */

import { CodeBlockPreviewExtension } from '@blocksuite/affine/blocks/code';
import { ParagraphViewExtension } from '@blocksuite/affine/blocks/paragraph/view';
import {
  type ViewExtensionContext,
  ViewExtensionManager,
  ViewExtensionProvider,
} from '@blocksuite/affine/ext-loader';
import { getInternalViewExtensions } from '@blocksuite/affine/extensions/view';
import { html } from 'lit';

class HtmlManager {
  htmlMap = new Map<string, HTMLElement>();

  renderHtml(htmlString: string) {
    if (!this.htmlMap.has(htmlString)) {
      const div = document.createElement('div');
      div.innerHTML = htmlString;
      const scriptList = Array.from(div.querySelectorAll('script'));
      this.htmlMap.set(htmlString, div);
      requestAnimationFrame(() => {
        scriptList.forEach(script => {
          const newScriptEl = document.createElement('script');
          Array.from(script.attributes).forEach(attr => {
            newScriptEl.setAttribute(attr.name, attr.value);
          });
          const scriptText = document.createTextNode(script.innerHTML);
          newScriptEl.appendChild(scriptText);
          script.parentNode?.replaceChild(newScriptEl, script);
        });
      });
    }
    return this.htmlMap.get(htmlString);
  }
}

const htmlManager = new HtmlManager();

class ComposerViewExtensionProvider extends ViewExtensionProvider {
  override name = 'composer';

  override setup(context: ViewExtensionContext) {
    super.setup(context);
    context.register(
      CodeBlockPreviewExtension('html', model => {
        const code = model.props.text.toString();
        if (!code.trim()) return null;
        return html`${htmlManager.renderHtml(code)}`;
      })
    );
  }
}

let manager: ViewExtensionManager | null = null;

export function getComposerViewManager() {
  if (!manager) {
    manager = new ViewExtensionManager([
      ...getInternalViewExtensions(),
      ComposerViewExtensionProvider,
    ]);

    manager.configure(ParagraphViewExtension, {
      getPlaceholder: () => '',
    });
  }
  return manager;
}
