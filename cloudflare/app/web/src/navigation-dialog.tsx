import { useEffect, useRef, useState } from "react";
import { listenForNavigationPrompt, type NavigationPrompt } from "./navigation-guard";

export function NavigationGuardDialog() {
  const [prompt, setPrompt] = useState<NavigationPrompt | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const keepEditing = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => listenForNavigationPrompt((next) => {
    if (next) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPrompt(next);
  }), []);
  useEffect(() => {
    if (prompt) { dialog.current?.showModal(); keepEditing.current?.focus(); }
    else dialog.current?.close();
  }, [prompt]);
  function finish(leave: boolean) {
    dialog.current?.close();
    prompt?.finish(leave);
    if (!leave && opener.current?.isConnected) opener.current.focus();
  }
  const busy = prompt?.state === "busy";
  return <dialog ref={dialog} className="navigation-dialog" aria-labelledby="navigation-dialog-title" aria-describedby="navigation-dialog-description" onCancel={(event) => { event.preventDefault(); finish(false); }}>
    <h2 id="navigation-dialog-title">{busy ? "A solicitação ainda está em andamento" : "Você tem alterações não salvas"}</h2>
    <p id="navigation-dialog-description">{busy ? "Aguarde a confirmação antes de sair desta tela. Assim você acompanha o resultado da solicitação." : "Se sair agora, as alterações desta tela serão descartadas. Você pode continuar editando e salvar antes de sair."}</p>
    <div className="button-row"><button ref={keepEditing} className="button primary" onClick={() => finish(false)}>{busy ? "Continuar nesta tela" : "Continuar editando"}</button>{!busy && <button className="button secondary" onClick={() => finish(true)}>Sair sem salvar</button>}</div>
  </dialog>;
}
