// Application header with branding
import Image from "next/image";
import Vector11Logo from "../assets/logo.png";

export const Header = () => {
  return (
    <header className="rounded-3xl border border-neutral-900/20 bg-white/85 p-6 shadow-[0_16px_40px_-24px_rgba(15,23,42,0.7)] backdrop-blur sm:p-7">
      <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-5">
          <Image src={Vector11Logo} alt="Vector11 Logo" width={190} priority />
          <div className="border-l-2 border-emerald-600 pl-5">
            <p className="text-xs font-mono uppercase tracking-[0.24em] text-emerald-700">
              Matchday Intelligence
            </p>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              Vector11 AI Chat
            </h1>
            <p className="mt-2 max-w-xl text-sm text-neutral-600">
              Ask tactical football questions across EPL, Africa, and European
              competitions.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono uppercase tracking-[0.14em] text-neutral-700">
          <span className="rounded-full border border-neutral-300 bg-white px-3 py-1">
            Football Only
          </span>
          <span className="rounded-full border border-neutral-300 bg-white px-3 py-1">
            50 Prompt Bank
          </span>
          <span className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-emerald-700">
            <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
            Live
          </span>
        </div>
      </div>
    </header>
  );
};
