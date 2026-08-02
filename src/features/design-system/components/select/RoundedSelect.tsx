import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Check } from "lucide-react";
import { joinClassNames } from "../classNames";
import { PopoverSurface } from "../popover/PopoverPrimitives";

export type RoundedSelectOption = {
  value: string;
  label: string;
  title?: string;
  disabled?: boolean;
};

type RoundedSelectProps = {
  value: string;
  options: RoundedSelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
  popoverClassName?: string;
  style?: CSSProperties;
  emptyLabel?: string;
  children?: ReactNode;
};

export function RoundedSelect({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  className,
  popoverClassName,
  style,
  emptyLabel = "无选项",
  children,
}: RoundedSelectProps) {
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [isOpen, setIsOpen] = useState(false);
  const selectedIndex = useMemo(
    () => options.findIndex((option) => option.value === value),
    [options, value],
  );
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : null;
  const [activeIndex, setActiveIndex] = useState(
    selectedIndex >= 0 ? selectedIndex : 0,
  );

  useEffect(() => {
    if (!isOpen) {
      setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
      return;
    }
    const target = optionRefs.current[activeIndex];
    target?.focus();
  }, [activeIndex, isOpen, selectedIndex]);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [isOpen]);

  const moveActive = useCallback(
    (direction: 1 | -1) => {
      if (options.length === 0) {
        return;
      }
      let next = activeIndex;
      for (let attempt = 0; attempt < options.length; attempt += 1) {
        next = (next + direction + options.length) % options.length;
        if (!options[next]?.disabled) {
          setActiveIndex(next);
          return;
        }
      }
    },
    [activeIndex, options],
  );

  const selectOption = useCallback(
    (option: RoundedSelectOption) => {
      if (option.disabled) {
        return;
      }
      onChange(option.value);
      setIsOpen(false);
    },
    [onChange],
  );

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setIsOpen(true);
      setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setIsOpen((current) => !current);
    }
  };

  const handleOptionKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    option: RoundedSelectOption,
  ) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setIsOpen(false);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(-1);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectOption(option);
    }
  };

  return (
    <div className="ds-rounded-select" ref={rootRef}>
      <button
        type="button"
        className={joinClassNames("composer-select composer-select-trigger", className)}
        style={style}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={listboxId}
        data-button-elevation="none"
        disabled={disabled}
        title={selectedOption?.title}
        onClick={() => setIsOpen((current) => !current)}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="composer-select-trigger-label">
          {children ?? selectedOption?.label ?? emptyLabel}
        </span>
      </button>
      {isOpen && !disabled && (
        <PopoverSurface
          className={joinClassNames("ds-rounded-select-popover", popoverClassName)}
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
        >
          {options.length === 0 ? (
            <div className="ds-rounded-select-empty">{emptyLabel}</div>
          ) : (
            options.map((option, index) => {
              const selected = option.value === value;
              return (
                <button
                  key={option.value || `empty-${index}`}
                  ref={(node) => {
                    optionRefs.current[index] = node;
                  }}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  disabled={option.disabled}
                  title={option.title}
                  className={joinClassNames(
                    "ds-rounded-select-option",
                    selected && "is-selected",
                    index === activeIndex && "is-active",
                  )}
                  onClick={() => selectOption(option)}
                  onKeyDown={(event) => handleOptionKeyDown(event, option)}
                  onMouseEnter={() => setActiveIndex(index)}
                >
                  <span className="ds-rounded-select-option-label">
                    {option.label}
                  </span>
                  {selected ? (
                    <Check className="ds-rounded-select-check" size={13} />
                  ) : null}
                </button>
              );
            })
          )}
        </PopoverSurface>
      )}
    </div>
  );
}
