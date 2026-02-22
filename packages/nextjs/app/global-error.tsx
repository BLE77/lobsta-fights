"use client";

interface GlobalErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function GlobalErrorBoundary({ error, reset }: GlobalErrorProps) {
  console.error("Global app error:", error);

  return (
    <html lang="en" className="bg-stone-950">
      <body className="bg-stone-950 text-stone-200 antialiased">
        <main className="min-h-screen">
          <div className="mx-auto flex h-full min-h-screen max-w-3xl items-center justify-center px-4 py-12">
            <div className="w-full rounded-sm border border-stone-700 bg-stone-900/90 p-8">
              <p className="text-xs font-mono uppercase text-stone-500 tracking-wider">Global Error</p>
              <h1 className="mt-2 text-2xl font-fight text-stone-100">Unexpected error loading the page</h1>
              <p className="mt-3 text-sm text-stone-300">
                The application experienced a crash in the root layout. Please reload to restart.
              </p>
              <button
                type="button"
                onClick={() => {
                  reset();
                  if (typeof window !== "undefined") {
                    window.location.reload();
                  }
                }}
                className="mt-6 inline-flex items-center justify-center rounded-sm bg-amber-600 px-5 py-2 text-sm font-mono uppercase tracking-wider text-stone-950 transition hover:bg-amber-500"
              >
                Reload
              </button>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
