"use client";

import { useEffect, useId, useRef, useState } from "react";
import { IconCheck, IconChevronRight } from "./icons";

export type SelectOption = { value: string; label: string };

// A real listbox, not a native select — the OS draws that popup and no amount
// of CSS reaches it. A hidden input carries the value so this still works in a
// plain server-action form.
//
// Dressed entirely in the dashboard's own vocabulary: the trigger is a
// `.pixie-input` (so it is the same rectangle as every field beside it), the
// menu is a `.pixie-panel` with square corners and no drop shadow, hovering an
// option raises it to `--color-panel-2`, and the chosen one is marked with the
// lime pixel check. The chevron is the pack's right-arrow sprite rotated a
// quarter turn rather than a hand-drawn SVG, so it stays on the pixel grid.
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
        className="pixie-input flex items-center justify-between gap-2 text-left"
      >
        <span className="truncate">{selected?.label ?? ""}</span>
        <IconChevronRight
          size={16}
          className={`shrink-0 text-text-muted ${open ? "rotate-270" : "rotate-90"}`}
        />
      </button>

      {open && (
        <ul
          id={listId}
          role="listbox"
          tabIndex={-1}
          aria-activedescendant={`${listId}-${active}`}
          className="pixie-panel absolute z-30 mt-1 max-h-60 w-full overflow-auto p-1"
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
                className={`flex cursor-pointer items-center justify-between gap-2 rounded-[2px] px-2.5 py-1.5 text-[13px] ${
                  index === active ? "bg-panel-2 text-text" : isSelected ? "text-text" : "text-text-muted"
                }`}
              >
                <span className="truncate">{option.label}</span>
                {isSelected && <IconCheck size={16} className="shrink-0 text-brand" />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
