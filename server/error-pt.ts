// Errors of the bot's computer as people read them in a conversation, in
// pt-BR like the bots answer. The English original stays in server.log and
// in what the model reads; only the chip is translated.

const KNOWN: Array<[RegExp, string]> = [
  [/This desktop image cannot safely resume/i, "a VM local não pode ser retomada com segurança; recrie a VM local"],
  [/^Start (docker|podman|container) first/i, "o $1 não está rodando; inicie-o primeiro"],
  [/Cannot connect to the Docker daemon/i, "não foi possível falar com o Docker; ele está rodando?"],
  [/Install a supported container runtime first/i, "instale um runtime de contêiner compatível primeiro"],
  [/The Local VM started, but Cua Driver is not ready yet/i, "a VM local subiu, mas o Cua Driver ainda não está pronto"],
  [/The Local VM desktop failed to start/i, "a área de trabalho da VM local não iniciou"],
  [/Create the Local VM/i, "crie a VM local"],
  [/recreate it$/i, "a VM local precisa ser recriada"],
];

/** The pt-BR reading of a known computer error, or the message as it is. */
export function computerErrorPt(message: string): string {
  for (const [pattern, text] of KNOWN) {
    const match = pattern.exec(message);
    if (match) return text.replace("$1", match[1] ?? "");
  }
  return message;
}
