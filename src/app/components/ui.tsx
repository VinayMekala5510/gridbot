"use client";
import type { ReactNode } from "react";

/** Small "i" badge that shows help text on hover/focus. */
export function Info({ text }: { text: string }) {
  return <span className="info" tabIndex={0} role="img" aria-label={text} data-tip={text}>i</span>;
}

export function Card({ title, icon, children, className = "" }: { title: string; icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`form-card ${className}`}>
      <h2 className="form-card-title">{icon && <span className="form-card-icon">{icon}</span>}{title}</h2>
      {children}
    </section>
  );
}

export function Field({ label, info, children }: { label: string; info?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}{info && <Info text={info} />}</span>
      {children}
    </label>
  );
}
