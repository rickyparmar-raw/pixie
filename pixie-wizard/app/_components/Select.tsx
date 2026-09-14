"use client";

import { useEffect, useId, useRef, useState } from "react";

export type SelectOption = { value: string; label: string };

// A real listbox, not a native select — the OS draws that popup and no amount
// of CSS reaches it. A hidden input carries the value so this still works in a
// plain server-action form.
export function Select({
  name,
  options,
  defaultValue,
  id,
  className = "",
  ariaLabel,
  onValueChange,
}: {
  name: string;
  options: readonly SelectOption[];
  defaultValue?: string;
  id?: string;
  className?: string;
  ariaLabel?: string;
  onValueChange?: (value: string) => void;
}) {
  const fallbackId = useId();
  const buttonId = id ?? fallbackId;
  const listId = `${buttonId}-list`;

  const initial = options.find((o) => o.value === defaultValue) ?? options[0];
  const [value, setValue] = useState(initial?.value ?? "");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(() => Math.max(0, options.findIndex((o) => o.value === (initial?.value ?? ""))));
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  const selected = options.find((o) => o.value === value) ?? initial;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    setValue(option.value);
    onValueChange?.(option.value);
    setOpen(false);
    button.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i + step + options.length) % options.length);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (open) choose(active);
      else setOpen(true);
    }
  };

  return (
    <div ref={root} className={`relative ${className}`}>
      <input type="hidden" name={name} value={value} />
      <button
        ref={button}
        type="button"
        id={buttonId}
        role="combobox"
        aria-controls={listId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        onClick={() => {
          setOpen((o) => !o);
          setActive(Math.max(0, options.findIndex((o) => o.value === value)));
        }}
        onKeyDown={onKeyDown}
        className="flex w-full items-center justify-between gap-2 rounded-md border border-line bg-panel-2 px-3 py-2 text-left text-sm text-text transition-colors hover:border-text-muted/50 focus:border-brand focus:outline-none"
      >
        <span className="truncate">{selected?.label ?? ""}</span>
        <svg
          aria-hidden
          width="13"
          height="13"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`shrink-0 text-text-muted transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path d="M4 6.5 8 10.5 12 6.5" />
        </svg>
      </button>

      {open && (
        <ul
          id={listId}
          role="listbox"
          tabIndex={-1}
          aria-activedescendant={`${listId}-${active}`}
          className="absolute z-20 mt-1.5 max-h-60 w-full overflow-auto rounded-md border border-line bg-panel py-1 shadow-[0_12px_28px_-12px_rgba(10,20,10,0.45)]"
        >
          {options.map((option, index) => {
            const isSelected = option.value === value;
            return (
              <li
                key={option.value}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => setActive(index)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(index);
                }}
                className={`flex cursor-pointer items-center justify-between gap-2 px-3 py-1.5 text-sm ${
                  index === active ? "bg-panel-2 text-text" : "text-text-muted"
                }`}
              >
                <span className="truncate">{option.label}</span>
                {isSelected && (
                  <svg aria-hidden width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-brand">
                    <path d="M3 8.5 6.5 12 13 4.5" />
                  </svg>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
