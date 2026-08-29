import { NextRequest, NextResponse } from 'next/server';

// Fixed upstream host -- not user-controlled, so no SSRF concern the way
// the general-purpose OPDS proxy has to guard against.
const WORDLENS_UPSTREAM_BASE = 'https://cdn.readest.com/wordlens';

// manifest.json changes over time; pack files are content-addressed via a
// sha256-derived ?v= query param already, so they're safe to cache hard.
const isManifestPath = (path: string[]) => path[path.length - 1] === 'manifest.json';

export async function GET(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  if (!path?.length) {
    return NextResponse.json({ error: 'Missing path' }, { status: 400 });
  }

  // Reject path traversal / anything that isn't a plain relative segment --
  // defense in depth even though the upstream base is fixed.
  if (path.some((segment) => segment.includes('..') || segment.includes('\\'))) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
  }

  const upstreamUrl = `${WORDLENS_UPSTREAM_BASE}/${path.map(encodeURIComponent).join('/')}${request.nextUrl.search}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const response = await fetch(upstreamUrl, {
      signal: controller.signal,
      headers: { Accept: '*/*' },
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return NextResponse.json(
        { error: `Upstream returned ${response.status}` },
        { status: response.status },
      );
    }

    const contentType = response.headers.get('Content-Type') || 'application/octet-stream';
    const cacheControl = isManifestPath(path)
      ? 'public, max-age=300' // manifest: short cache, it's the thing that tells us packs changed
      : 'public, max-age=31536000, immutable'; // packs: content-addressed via ?v=, cache forever

    return new NextResponse(response.body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': cacheControl,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return NextResponse.json({ error: 'Upstream request timed out' }, { status: 504 });
    }
    console.error('[WordLens Proxy] Error:', error);
    return NextResponse.json({ error: 'Failed to fetch from WordLens CDN' }, { status: 502 });
  }
}
