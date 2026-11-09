/** Individual mechanical tiles, with real text and ordinary word wrapping. */
export function FlapText({ text }: { text: string }) {
  return <span className="flap-text">{text.split(/(\s+)/).map((word, i) => /\s/.test(word)
    ? word : <span className="flap-word" key={i}>{[...word].map((char, j) => <span className="flap-char" key={j}>{char}</span>)}</span>)}</span>;
}
