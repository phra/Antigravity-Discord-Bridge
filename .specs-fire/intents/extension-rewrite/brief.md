---
id: extension-rewrite
title: "Complete Extension Rewrite — Fix Duplicate Processing & Multi-Conversation Support"
status: done
created: "2026-03-10T03:42:00Z"
---

# Intent: Complete Extension Rewrite

## Goal

Riscrivere completamente l'estensione Antigravity Discord Bridge per eliminare il bug di doppia processazione dei messaggi Discord e rendere Antigravity pienamente usabile da Discord, con supporto a conversazioni multiple.

## Users

- **Discord Users**: inviano messaggi al bot e ricevono risposte dall'AI di Antigravity
- **VS Code User**: sviluppatore che roda l'estensione e vede lo stato nel sidebar

## Problem

Dopo la migrazione da risposte nel canale principale a thread Discord per conversazioni multiple, è stato introdotto un bug di **doppia processazione dei messaggi**. La stessa risposta viene inviata due volte o in due thread separati. Le cause radice identificate sono:

1. **Possibile caricamento doppio dell'estensione**: Antigravity ha un "Agent Manager" che è una finestra dedicata all'agent. L'estensione potrebbe caricarsi sia nell'IDE che nell'Agent Manager, creando due istanze del bot Discord
2. **Re-emissione MessageCreate**: Discord re-emette il messaggio originale come thread message quando si chiama `startThread()`, causando doppia processazione
3. **Dedup layers incrementali**: I patch di deduplicazione (PID lock, seenMessageIds, processedMessageIds, reaction-based claim) sono stati aggiunti incrementalmente senza una soluzione architettonica pulita
4. **CDP target conteso**: Due extension host potrebbero competere per lo stesso CDP target

## Success Criteria

- Ogni messaggio Discord produce **esattamente una risposta** in **esattamente un thread**
- Nessun duplicato anche con multiple extension host caricate
- Supporto conversazioni multiple (sequenziali con comando switch, o parallele)
- Codice pulito, senza layer di dedup sovrapposti
- Auto-accept funzionante senza interferenze
- Response extraction affidabile (niente noise/debug leak)
- Test unitari e di integrazione per i componenti core

## Constraints

- Mantiene la stessa tech stack (TypeScript, discord.js, ws, esbuild, vitest)
- Mantiene la stessa interfaccia utente (VS Code settings, sidebar panel)
- CDP richiede Antigravity avviato con `--remote-debugging-port`
- Discord message limit 2000 chars
- CDP è sequenziale (un messaggio alla volta per connessione)
- Possibilità che Agent Manager abbia struttura DOM diversa dall'IDE

## Notes

- L'Agent Manager potrebbe essere il target CDP ideale (DOM flat, stabile)
- Investigare se l'estensione si carica effettivamente due volte
- Considerare un approccio "leader election" robusto invece del PID lock file
