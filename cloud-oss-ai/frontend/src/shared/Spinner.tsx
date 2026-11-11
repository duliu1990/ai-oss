interface SpinnerProps {
  /** Announced to assistive technology; omit when visible text already says what is loading. */
  label?: string;
  size?: 'small' | 'medium';
  className?: string;
}

export function Spinner({ label, size = 'medium', className }: SpinnerProps) {
  const classes = ['spinner', size === 'small' ? 'spinner--small' : '', className ?? ''].filter(Boolean).join(' ');
  return label
    ? <span aria-label={label} className={classes} role="status" />
    : <span aria-hidden="true" className={classes} />;
}
