import { getCurrentPage, useEditor } from '@/store/editor'
import * as project from '@/store/project'
import * as nodes from '@/model/nodes'
import * as create from '@/model/create'
import * as anchors from '@/model/anchors'
import * as layout from '@/export/layout'
import * as assets from '@/store/assets'
import * as viewMath from '@/canvas/viewMath'
import { readPsd } from 'ag-psd'
import * as restyle from '@/psd/restyle'
import { useTheme } from '@/store/theme'
import { useHover } from '@/store/hover'
import * as simulate from '@/model/simulate'
import * as instances from '@/model/instances'
import * as atlas from '@/export/atlas'
import * as compare from '@/canvas/compare'
import * as render from '@/canvas/render'
import * as autoAnchor from '@/model/autoAnchor'
import * as flows from '@/model/flows'
import * as autosave from '@/store/autosave'
import * as states from '@/model/states'
import { bridgeHandlers } from '@/bridge'

/** Exposes internals on window.__dm for automation scripts (DM_SCRIPT) and devtools debugging. */
export function installDebugApi(): void {
  ;(window as unknown as { __dm: unknown }).__dm = {
    useEditor,
    getCurrentPage,
    findByName: (name: string) => {
      const page = getCurrentPage()
      for (const e of nodes.indexPage(page).byId.values()) if (e.node.name === name) return e.node
      return undefined
    },
    ...project,
    ...nodes,
    ...create,
    ...anchors,
    ...layout,
    ...assets,
    ...viewMath,
    ...restyle,
    useTheme,
    useHover,
    readPsd,
    ...simulate,
    ...instances,
    ...atlas,
    ...compare,
    ...render,
    ...autoAnchor,
    ...flows,
    ...autosave,
    ...states,
    bridge: bridgeHandlers
  }
}
