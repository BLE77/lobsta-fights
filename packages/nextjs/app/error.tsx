"use client";

interface ErrorBoundaryProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function ErrorBoundary({ error, reset }: ErrorBoundaryProps) {
  console.error("Route error:", error);

  return (
    <main className="min-h-screen bg-stone-950 text-stone-200">
      <div className="mx-auto flex h-full min-h-screen max-w-3xl items-center justify-center px-4 py-12">
        <div className="w-full rounded-sm border border-stone-700 bg-stone-900/90 p-8">
          <p className="text-xs font-mono uppercase text-stone-500 tracking-wider">Error</p>
          <h1 className="mt-2 text-2xl font-fight text-stone-100">Something in the arena glitched.</h1>
          <p className="mt-3 text-sm text-stone-300">
            We hit an unexpected issue while loading this page. It can often be fixed by trying again.
          </p>
          <button
            type="button"
            onClick={() => reset()}
            className="mt-6 inline-flex items-center justify-center rounded-sm bg-amber-600 px-5 py-2 text-sm font-mono uppercase tracking-wider text-stone-950 transition hover:bg-amber-500"
          >
            Try Again
          </button>
        </div>
      </div>
    </main>
  );
}
