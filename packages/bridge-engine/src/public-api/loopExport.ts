import { figmaToHtml } from './figmaToHtml';
import { compositionToIR } from '../pipeline/ir';
import type { RenderNodeIR } from '../pipeline/types';

export type LoopExportResult = {
  bodyHtml: string;
  cssText: string;
  manifest: {
    schemaVersion: string;
    exportedAt: string;
    sessionId?: string | null;
    bounds: any;
    rootIds: string[];
    nodes: Record<string, any>;
    fonts?: any;
    engine: string;
  };
  assets: any;
  baseWidth: number;
  baseHeight: number;
};

function flattenIr(nodes: RenderNodeIR[], out: RenderNodeIR[] = []): RenderNodeIR[] {
  for (const node of nodes || []) {
    out.push(node);
    if (node.content && node.content.type === 'children') flattenIr(node.content.nodes, out);
  }
  return out;
}

export async function figmaSelectionToHtml(input: {
  composition: any;
  sessionId?: string | null;
  assetUrlProvider?: (id: string, type: 'image' | 'svg', data?: string) => string;
}): Promise<LoopExportResult> {
  const composition = input.composition;
  const ir = compositionToIR(composition);
  const rendered = await figmaToHtml({ composition }, {
    assetUrlProvider: input.assetUrlProvider,
    debugEnabled: false,
  });

  const nodes: Record<string, any> = {};
  for (const node of flattenIr(ir.nodes)) {
    nodes[node.id] = {
      id: node.id,
      name: node.name,
      type: node.type,
      kind: node.kind,
      selector: `[data-figma-id="${node.id}"]`,
      text: node.text && typeof node.text.characters === 'string' ? node.text.characters : '',
      layout: node.layout,
      style: node.style?.raw || {},
    };
  }

  return {
    bodyHtml: rendered.content.bodyHtml,
    cssText: rendered.content.cssText,
    manifest: {
      schemaVersion: '0.2.0',
      exportedAt: new Date().toISOString(),
      sessionId: input.sessionId || null,
      bounds: composition.bounds || null,
      rootIds: Array.isArray(composition.children) ? composition.children.map((node: any) => String(node.id)) : [],
      nodes,
      fonts: {
        used: ir.fontMeta?.fonts || [],
      },
      engine: '@figma-html-loop/bridge-engine',
    },
    assets: rendered.assets,
    baseWidth: rendered.content.baseWidth || rendered.baseWidth,
    baseHeight: rendered.content.baseHeight || rendered.baseHeight,
  };
}
