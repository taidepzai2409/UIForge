import { Application, Rectangle } from 'pixi.js'
import type { Asset, FrameNode, Page } from '@/model/types'
import { collectAssetIds } from '@/model/nodes'
import { getTexture, pngFromCanvas } from '@/store/assets'
import { createScene, destroyScene, syncScene } from './sync'

let app: Application | null = null

async function getApp(): Promise<Application> {
  if (!app) {
    const a = new Application()
    await a.init({ width: 64, height: 64, backgroundAlpha: 0, antialias: true, resolution: 1, autoDensity: false })
    app = a
  }
  return app
}

/** Renders one frame (at its natural size) into a canvas, independent of the editor viewport. */
export async function renderFrameToCanvas(page: Page, frame: FrameNode, assets: Record<string, Asset>, scale = 1): Promise<HTMLCanvasElement> {
  const a = await getApp()
  const ids = collectAssetIds([frame])
  await Promise.allSettled(Array.from(ids).map((id) => (assets[id] ? getTexture(assets[id]) : Promise.resolve())))
  const scene = createScene()
  const tempPage: Page = { ...page, children: [{ ...frame, x: 0, y: 0 }] }
  syncScene(scene, tempPage, assets)
  a.stage.addChild(scene.root)
  const canvas = a.renderer.extract.canvas({
    target: scene.root,
    resolution: scale,
    frame: new Rectangle(0, 0, frame.width, frame.height)
  }) as HTMLCanvasElement
  destroyScene(scene)
  return canvas
}

export async function renderFramePng(page: Page, frame: FrameNode, assets: Record<string, Asset>, scale = 1): Promise<Uint8Array> {
  return pngFromCanvas(await renderFrameToCanvas(page, frame, assets, scale))
}
