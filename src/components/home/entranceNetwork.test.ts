import { describe, expect, it } from 'vitest'
import {
  ENTRANCE_MODES,
  buildEntranceNetwork,
  boxesIntersect,
  pickEntranceMode,
  type EntranceMode,
} from './entranceNetwork'

describe('entrance network compositions', () => {
  for (const mode of ENTRANCE_MODES) {
    describe(mode, () => {
      const network = buildEntranceNetwork(mode)

      it('keeps every card and pill clear of the reserved brand band', () => {
        const reserved = network.nodes.filter((node) => node.kind !== 'peripheral')
        expect(reserved.length).toBeGreaterThan(2)
        for (const node of reserved) {
          expect(
            boxesIntersect(node, network.brand),
            `${node.id} intrudes into the wordmark band`,
          ).toBe(false)
        }
      })

      it('keeps the whole composition inside the virtual canvas', () => {
        for (const node of network.nodes) {
          expect(node.x, node.id).toBeGreaterThanOrEqual(0)
          expect(node.y, node.id).toBeGreaterThanOrEqual(0)
          expect(node.x + node.w, node.id).toBeLessThanOrEqual(network.width)
          expect(node.y + node.h, node.id).toBeLessThanOrEqual(network.height)
        }
        expect(network.brand.x + network.brand.w).toBeLessThanOrEqual(network.width)
        expect(network.brand.y + network.brand.h).toBeLessThanOrEqual(network.height)
      })

      it('wires only real nodes and paints a layered network', () => {
        const ids = new Set(network.nodes.map((node) => node.id))
        expect(ids.size).toBe(network.nodes.length)
        for (const edge of network.edges) {
          expect(ids.has(edge.from), edge.id).toBe(true)
          expect(ids.has(edge.to), edge.id).toBe(true)
          expect(edge.d.startsWith('M ')).toBe(true)
        }
        const kinds = new Set(network.nodes.map((node) => node.kind))
        expect(kinds.has('primary')).toBe(true)
        expect(kinds.has('secondary')).toBe(true)
        expect(kinds.has('peripheral')).toBe(true)
        expect(network.signals.length).toBeGreaterThan(0)
      })

      it('stages the reveal inside the three second window', () => {
        const end = Math.max(
          ...network.nodes.map((node) => node.done),
          ...network.edges.map((edge) => edge.delay + edge.duration),
        )
        expect(end).toBeLessThan(2.7)
      })
    })
  }
})

describe('pickEntranceMode', () => {
  const cases: Array<[number, number, EntranceMode]> = [
    [1920, 1080, 'desktop'],
    [1440, 900, 'desktop'],
    [1280, 800, 'compact'],
    [1024, 768, 'compact'],
    [768, 1024, 'tablet'],
    [430, 932, 'phone'],
    [390, 844, 'phone'],
    [320, 568, 'phone'],
    [844, 390, 'landscape'],
  ]

  for (const [width, height, expected] of cases) {
    it(`${width}x${height} uses the ${expected} composition`, () => {
      expect(pickEntranceMode(width, height)).toBe(expected)
    })
  }
})
