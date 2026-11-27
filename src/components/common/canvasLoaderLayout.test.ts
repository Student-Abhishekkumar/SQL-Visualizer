import { describe, expect, it } from 'vitest'
import { buildEdgeGeometry, buildGraph, pickLoaderMode } from './canvasLoaderLayout'

describe('canvasLoaderLayout', () => {
  it('chooses a composition per viewport', () => {
    expect(pickLoaderMode(1440, 900)).toBe('desktop')
    expect(pickLoaderMode(1920, 1080)).toBe('desktop')
    expect(pickLoaderMode(768, 1024)).toBe('portrait')
    expect(pickLoaderMode(390, 844)).toBe('short')
    expect(pickLoaderMode(320, 568)).toBe('short')
  })

  it('builds a connected desktop graph with real socket sides', () => {
    const graph = buildGraph('desktop')
    expect(graph.nodes).toHaveLength(8)
    expect(graph.edges).toHaveLength(8)

    for (const edge of graph.edges) {
      const geometry = graph.geometry[edge.id]
      expect(geometry).toBeDefined()
      expect(geometry?.d.startsWith('M')).toBe(true)
      expect(geometry?.d).toContain(' C')
      expect(Number.isFinite(geometry?.arrow.angle)).toBe(true)
      expect(graph.sockets[edge.from]?.length).toBeGreaterThan(0)
      expect(graph.sockets[edge.to]?.length).toBeGreaterThan(0)
    }
  })

  it('builds a vertical portrait graph', () => {
    const graph = buildGraph('portrait')
    expect(graph.nodes).toHaveLength(6)
    expect(graph.edges).toHaveLength(5)
  })

  it('builds a compact short-screen graph', () => {
    const graph = buildGraph('short')
    expect(graph.nodes).toHaveLength(4)
    expect(graph.edges).toHaveLength(3)
  })

  it('derives smooth cubic geometry between two nodes', () => {
    const geometry = buildEdgeGeometry(
      { x: 0, y: 0, w: 100, h: 60 },
      { x: 300, y: 120, w: 100, h: 60 },
    )
    expect(geometry.d).toMatch(/^M[\d.]+,[\d.]+ C/)
    // The arrowhead sits on the target node's left socket.
    expect(geometry.arrow.x).toBe(300)
    expect(geometry.arrow.y).toBe(150)
  })
})