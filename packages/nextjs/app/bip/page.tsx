import Link from "next/link";

export default function BIP() {
    const items = [
        { text: "Training Season Explainer Video", completed: false, image: "/todo-image.png" },
        { text: "Replace artstyle of current robot generator", completed: false },
        { text: "Make house bots for big Ai companys, Grok, Anthropic, Open AI", completed: false },
        { text: "Switch to real time video generation", completed: false },
        { text: "Create account for ring girl and post about her life working for the UCF, automate it", completed: false },
        { text: "Plan Title Fights", completed: false },
        { text: "solana mobile intergration", completed: false },
    ];

    return (
        <main className="relative flex flex-col items-center min-h-screen text-stone-200 px-4 py-6 md:p-8 pt-safe overflow-x-hidden">
            {/* Background Video */}
            <div className="fixed inset-0 z-0 overflow-hidden">
                <video
                    autoPlay
                    loop
                    muted
                    playsInline
                    className="absolute inset-0 w-full h-full object-cover opacity-60 pointer-events-none"
                >
                    <source src="/hero-bg.mp4" type="video/mp4" />
                </video>
                <div className="absolute inset-0 bg-stone-950/85 pointer-events-none"></div>
                {/* CRT Scanline Overlay */}
                <div className="scanlines-overlay pointer-events-none"></div>
            </div>

            <div className="relative z-10 w-full max-w-3xl flex flex-col pt-6 md:pt-8">
                <style dangerouslySetInnerHTML={{
                    __html: `
                    @import url('https://fonts.googleapis.com/css2?family=Special+Elite&display=swap');
                    .font-typewriter { font-family: 'Special Elite', monospace; }
                    .paper-texture {
                        background-color: #e4e1d1;
                        background-image: url("data:image/svg+xml,%3Csvg width='100' height='100' viewBox='0 0 100 100' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100' height='100' filter='url(%23noise)' opacity='0.08'/%3E%3C/svg%3E");
                        box-shadow: 2px 3px 20px rgba(0,0,0,0.5), inset 0 0 60px rgba(150,140,120,0.3);
                    }
                `}} />

                <div className="relative flex flex-col md:flex-row md:items-center md:justify-center gap-3 md:gap-0 mb-8 md:mb-12 animate-fade-in-up" style={{ animationDelay: '100ms', animationFillMode: 'both' }}>
                    <Link
                        href="/"
                        className="md:absolute md:left-0 text-stone-500 hover:text-amber-500 font-mono text-sm transition-colors flex items-center gap-2"
                    >
                        ← BACK TO BASE
                    </Link>
                    <h1 className="font-fight-glow-intense text-4xl md:text-6xl text-amber-400 tracking-wider text-center">
                        BUILD IN PUBLIC
                    </h1>
                </div>

                <div className="animate-fade-in-up" style={{ animationDelay: '300ms', animationFillMode: 'both' }}>

                    {/* Paper Container */}
                    <div className="relative paper-texture text-stone-900 rounded-sm p-8 md:p-12 mx-auto rotate-1 max-w-2xl">

                        {/* Tape effect */}
                        <div className="absolute -top-4 left-1/2 -translate-x-1/2 w-40 h-8 bg-stone-100/40 backdrop-blur-sm -rotate-2 shadow-sm border border-white/30"></div>

                        {/* Header */}
                        <div className="border-b-2 border-stone-800/30 pb-6 mb-8 mt-2 relative z-20">
                            <h2 className="text-4xl md:text-5xl font-typewriter font-bold tracking-widest text-stone-900 uppercase text-center">
                                To-Do
                            </h2>
                        </div>

                        {/* List Items */}
                        <div className="relative z-20 min-h-[400px]">
                            <ul className="flex flex-col gap-6">
                                {items.map((item, idx) => (
                                    <li
                                        key={idx}
                                        className="relative flex items-start gap-4 transition-all duration-300 group"
                                    >
                                        <div className="mt-1 flex-shrink-0">
                                            <div className="font-typewriter text-xl font-bold text-stone-900">
                                                [{item.completed ? 'X' : ' '}]
                                            </div>
                                        </div>

                                        <div className="flex flex-col gap-3 w-full">
                                            <p className={`font-typewriter text-xl leading-relaxed transition-colors duration-300 ${item.completed ? 'text-stone-600 line-through' : 'text-stone-900 font-bold'}`}>
                                                {item.text}
                                            </p>
                                            {item.image && (
                                                <div className="mt-4 mx-auto w-32 md:w-48 relative bg-transparent">
                                                    <img src={item.image} alt={item.text} className="w-full h-auto object-cover grayscale opacity-90 mix-blend-multiply" />
                                                </div>
                                            )}
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    </div>
                </div>
            </div>
        </main>
    );
}
