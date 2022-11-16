/*!
 * Copyright 2022 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vs from 'vscode'
import { Event, EventEmitter, ExtensionContext } from 'vscode'
import { registerHttpsFileSystem } from './http-filesystem'
import { TelemetryEventName, SearchTrigger } from '../telemetry/telemetry/types'
import { SearchHistoryStore } from '../stores/searchHistoryStore'
import { PanelStore } from '../stores/panelStore'
import { showNotification } from '../utils/notify'
import { SearchHistoryDisplay } from './search-history-display'
import { AutocompleteDisplay } from './autocomplete-display'
import { LiveSearchDisplay } from './live-search'
import { StatusBar } from '../utils/status-bar'
import {
    CodeQuery,
    CodeSelection,
    Query,
    QueryContext,
    SearchInput,
    SearchOutput,
    SearchSuggestion,
    Trigger,
} from '../models/model'
import { getIcon, Icon } from '../../shared/icons'
import { Telemetry } from '../telemetry/telemetry/interfaces'
import { telemetry } from '../../shared/telemetry/telemetry'

enum LiveSearchCommands {
    PAUSE = 'Mynah.LiveSearchPause',
    RESUME = 'Mynah.LiveSearchResume',
    STOP = 'Mynah.LiveSearchStop',
}
const emitter: EventEmitter<SearchSuggestion[]> = new EventEmitter()
export const showSuggestions: Event<SearchSuggestion[]> = emitter.event

export interface ResultDisplayProps {
    client: Telemetry
    input: SearchInput
    searchHistoryStore: SearchHistoryStore
    panelStore: PanelStore
    searchHistoryDisplay: SearchHistoryDisplay
    autocompleteDisplay: AutocompleteDisplay
    liveSearchDisplay: LiveSearchDisplay
}

/**
 * The result display has a search bar which can be used to refine the search results that are currently displayed.
 * When the display is shown, the search bar always contains the query that gives the shown results.
 *
 * When the result display is shown without the user typing in a textual query, then the search bar query is updated to reflect the shown results, but the Mynah textual search input is not updated.
 */
export class ResultDisplay {
    private readonly assetsPath: vs.Uri
    private readonly searchInput: SearchInput
    private readonly client: Telemetry
    private readonly searchHistoryStore: SearchHistoryStore
    private readonly panelStore: PanelStore
    private readonly searchHistoryDisplay: SearchHistoryDisplay
    private readonly autocompleteDisplay: AutocompleteDisplay
    private readonly liveSearchDisplay: LiveSearchDisplay
    private liveSearchStatusBarControl!: StatusBar | undefined
    private uiReady: Record<string, boolean> = {}

    constructor(private readonly context: ExtensionContext, props: ResultDisplayProps) {
        registerHttpsFileSystem(context)
        this.assetsPath = vs.Uri.joinPath(context.extensionUri)
        this.searchInput = props.input
        this.client = props.client
        this.searchHistoryStore = props.searchHistoryStore
        this.panelStore = props.panelStore
        this.searchHistoryDisplay = props.searchHistoryDisplay
        this.autocompleteDisplay = props.autocompleteDisplay
        this.liveSearchDisplay = props.liveSearchDisplay

        // Add live search control commands
        vs.commands.registerCommand(LiveSearchCommands.PAUSE, this.pauseLiveSearch.bind(this))
        vs.commands.registerCommand(LiveSearchCommands.RESUME, this.resumeLiveSearch.bind(this))
        vs.commands.registerCommand(LiveSearchCommands.STOP, this.stopLiveSearch.bind(this))
    }

    /**
     * Pauses live search and informs the UI
     */
    private readonly pauseLiveSearch = (): void => {
        const liveSearchPanelId = this.panelStore.getLiveSearchPanelId()
        if (liveSearchPanelId !== undefined) {
            if (!this.liveSearchDisplay.isLiveSearchPaused()) {
                const panel = this.panelStore.getPanel(liveSearchPanelId)
                const session = panel?.telemetrySession
                session?.recordEvent(TelemetryEventName.PAUSE_LIVE_SEARCH)
                this.liveSearchDisplay.pauseLiveSearch()

                void panel?.webviewPanel.webview.postMessage(
                    JSON.stringify({
                        liveSearchAction: 'pauseLiveSearch',
                    })
                )
            }
        }

        // Update state of the status bar control
        this.liveSearchStatusBarControl?.update({
            commands: {
                Resume: LiveSearchCommands.RESUME,
                Stop: LiveSearchCommands.STOP,
            },
        })
    }

    /**
     * Resumes live search and informs the UI
     */
    private readonly resumeLiveSearch = (): void => {
        const liveSearchPanelId = this.panelStore.getLiveSearchPanelId()
        if (liveSearchPanelId !== undefined) {
            if (this.liveSearchDisplay.isLiveSearchPaused()) {
                const panel = this.panelStore.getPanel(liveSearchPanelId)
                const session = panel?.telemetrySession
                session?.recordEvent(TelemetryEventName.RESUME_LIVE_SEARCH)
                this.liveSearchDisplay.resumeLiveSearch()

                void panel?.webviewPanel.webview.postMessage(
                    JSON.stringify({
                        liveSearchAction: 'resumeLiveSearch',
                    })
                )
            }
        }

        // Update state of the status bar control
        this.liveSearchStatusBarControl?.update({
            commands: {
                Pause: LiveSearchCommands.PAUSE,
                Stop: LiveSearchCommands.STOP,
            },
        })
    }

    /**
     * Stops live search completely until there is a new live panel and informs the UI
     */
    private readonly stopLiveSearch = (): void => {
        const liveSearchPanelId = this.panelStore.getLiveSearchPanelId()
        if (liveSearchPanelId !== undefined) {
            const panel = this.panelStore.getPanel(liveSearchPanelId)
            const session = panel?.telemetrySession
            session?.recordEvent(TelemetryEventName.REFINE_LIVE_SEARCH)
            this.panelStore.clearLiveSearchPane()

            void panel?.webviewPanel.webview.postMessage(
                JSON.stringify({
                    liveSearchAction: 'stopLiveSearch',
                })
            )

            // Remove status bar control completely
            this.removeStatusBarControl()
        }
    }

    private removeStatusBarControl(): void {
        this.liveSearchStatusBarControl?.destroy()
        this.liveSearchStatusBarControl = undefined
    }

    private getPanelTitle(input: string, fileName: string, selectionRangeStart: string): string {
        const MAX_PANEL_TITLE_LENGTH = 22

        let title = ''

        if (input.length > 0) {
            if (input.length > MAX_PANEL_TITLE_LENGTH / 2) {
                title = title + input.slice(0, MAX_PANEL_TITLE_LENGTH / 2) + '…'
            } else {
                title = title + input
            }
        }

        if (fileName.length > 0) {
            if (title.length > 0) {
                title = title + ' '
            }

            title = title + selectionRangeStart + ' '

            const fileNameLastPart = fileName.split('/').pop()

            if (fileName.length > MAX_PANEL_TITLE_LENGTH / 2) {
                // eslint-disable-next-line @typescript-eslint/restrict-plus-operands
                title = title + fileNameLastPart?.slice(0, MAX_PANEL_TITLE_LENGTH / 2) + '…'
            } else {
                // eslint-disable-next-line @typescript-eslint/restrict-plus-operands
                title = title + fileNameLastPart
            }
        }

        return title
    }

    private setupPanel(panelId: string, query: Query, live: boolean): void {
        const { input, queryContext, trigger, code, sourceId } = query
        const viewColumn = this.panelStore.getMostRecentPanel()?.webviewPanel.viewColumn ?? vs.ViewColumn.Beside
        const fileName =
            query.codeSelection !== undefined
                ? query.codeSelection.file !== undefined
                    ? query.codeSelection.file.name
                    : ''
                : ''
        const selectionRangeStart =
            query.codeSelection?.file !== undefined
                ? `${query.codeSelection.file.range.start.row}:${query.codeSelection.file.range.start.column}`
                : ''
        const dist = vs.Uri.joinPath(this.context.extensionUri, 'dist')
        const resources = vs.Uri.joinPath(this.context.extensionUri, 'resources')
        const panel = vs.window.createWebviewPanel(
            'mynah-search-results',
            this.getPanelTitle(input, fileName, selectionRangeStart),
            viewColumn,
            {
                enableScripts: true,
                enableCommandUris: true,
                retainContextWhenHidden: true,
                localResourceRoots: [dist, resources],
            }
        )
        panel.onDidChangeViewState(_ => {
            const panel = this.panelStore.getPanel(panelId)
            if (panel === undefined) {
                return
            }
            session.recordEvent(
                panel.webviewPanel.active ? TelemetryEventName.ENTER_FOCUS : TelemetryEventName.LEAVE_FOCUS
            )
        })
        const session = this.client.newSession(panelId)
        const context = {
            should: Array.from(queryContext.should),
            must: Array.from(queryContext.must),
            mustNot: Array.from(queryContext.mustNot),
        }
        session.recordEvent(TelemetryEventName.SEARCH, {
            searchMetadata: {
                query: input,
                trigger: this.getTelemetrySearchTrigger(trigger),
                queryContext: context,
                code,
                sourceId,
                codeQuery: query.codeQuery,
                implicit: query.implicit ?? false,
            },
        })
        telemetry.mynah_search.emit({
            mynahQuery: input,
            mynahQueryContext: JSON.stringify(context),
            mynahTrigger: this.getTelemetrySearchTrigger(trigger),
            mynahCode: code,
            mynahSourceId: sourceId,
            mynahCodeQuery: JSON.stringify(query.codeQuery),
            mynahImplicit: query.implicit ?? false,
        })

        panel.webview.onDidReceiveMessage(msg => {
            const panel = this.panelStore.getPanel(panelId)
            if (panel === undefined) {
                return
            }
            const session = panel.telemetrySession
            const trigger = msg.trigger ?? SearchTrigger.SEARCH_PANE
            const fileName =
                msg.codeSelection !== undefined
                    ? msg.codeSelection.file !== undefined
                        ? msg.codeSelection.file.name
                        : ''
                    : ''
            const selectionRangeStart =
                msg.codeSelection?.file !== undefined
                    ? `${String(msg.codeSelection.file.range.start.row)}:${String(
                          msg.codeSelection.file.range.start.column
                      )}`
                    : ''
            const newSession = this.client.newSession(panelId)
            const fromAutocomplete = msg.fromAutocomplete ?? false
            switch (msg.command) {
                case 'uiReady':
                    this.uiReady[panelId] = true
                    break
                case 'search':
                    panel.webviewPanel.title = this.getPanelTitle(msg.text, fileName, selectionRangeStart)
                    panel.telemetrySession = newSession
                    newSession.recordEvent(TelemetryEventName.SEARCH, {
                        searchMetadata: {
                            query: msg.text,
                            queryContext: msg.context,
                            trigger,
                            code,
                            codeQuery: msg.codeQuery,
                            implicit: msg.implicit ?? false,
                            fromAutocomplete,
                        },
                    })
                    telemetry.mynah_search.emit({
                        mynahQuery: msg.text,
                        mynahQueryContext: JSON.stringify(msg.context),
                        mynahTrigger: trigger,
                        mynahCode: code,
                        mynahCodeQuery: JSON.stringify(msg.codeQuery),
                        mynahImplicit: msg.implicit ?? false,
                        mynahFromAutocomplete: fromAutocomplete,
                    })
                    // Since the search performs when the extension's search-input changes, we don't want to trigger a real search for history items.
                    if (trigger !== SearchTrigger.SEARCH_HISTORY) {
                        void this.searchInput.searchText(
                            msg.text,
                            msg.context,
                            code,
                            panelId,
                            msg.codeQuery,
                            msg.codeSelection
                        )
                    }
                    break
                case 'upvote':
                    session.recordEvent(TelemetryEventName.UPVOTE_SUGGESTION, {
                        suggestionMetadata: {
                            ...msg,
                        },
                    })
                    break
                case 'downvote':
                    session.recordEvent(TelemetryEventName.DOWNVOTE_SUGGESTION, {
                        suggestionMetadata: {
                            ...msg,
                        },
                    })
                    break
                case 'stars':
                    session.recordEvent(TelemetryEventName.STAR_RATE_SEARCH, {
                        feedbackMetadata: {
                            ...msg,
                        },
                    })
                    break
                case 'feedback':
                    session.recordEvent(TelemetryEventName.ENTER_FEEDBACK, {
                        feedbackMetadata: {
                            ...msg,
                        },
                    })
                    break
                case 'click':
                    void vs.env.openExternal(vs.Uri.parse(msg.suggestionId))
                    session.recordEvent(TelemetryEventName.CLICK_SUGGESTION, {
                        suggestionMetadata: {
                            ...msg,
                        },
                    })
                    break
                case 'notify':
                    showNotification(msg.type, msg.message, msg.details)
                    break
                case 'copy':
                    session.recordEvent(TelemetryEventName.COPY_SUGGESTION_LINK, {
                        suggestionMetadata: {
                            ...msg,
                        },
                    })
                    break
                case 'addQueryContext':
                    session.recordEvent(TelemetryEventName.ADD_QUERY_CONTEXT, {
                        queryContextMetadata: {
                            queryContext: msg.queryContext.context,
                            queryContextSource: msg.queryContext.source,
                            queryContextType: msg.queryContext.type,
                        },
                    })
                    break
                case 'removeQueryContext':
                    session.recordEvent(TelemetryEventName.REMOVE_QUERY_CONTEXT, {
                        queryContextMetadata: {
                            queryContext: msg.queryContext.context,
                            queryContextSource: msg.queryContext.source,
                            queryContextType: msg.queryContext.type,
                        },
                    })
                    break
                case 'openSuggestion':
                    session.recordEvent(TelemetryEventName.OPEN_SUGGESTION_LINK, {
                        suggestionMetadata: {
                            ...msg,
                        },
                    })
                    break
                case 'getSearchHistory':
                    void this.searchHistoryDisplay.showSearchHistoryList({ filters: msg.filters, panelId })
                    break
                case 'selectSuggestionText':
                    session.recordEvent(TelemetryEventName.SELECT_SUGGESTION_TEXT, {
                        suggestionMetadata: {
                            ...msg,
                        },
                    })
                    break
                case 'hoverSuggestion':
                    session.recordEvent(TelemetryEventName.HOVER_SUGGESTION, {
                        suggestionMetadata: {
                            ...msg,
                        },
                    })
                    break
                case 'liveSearch':
                    switch (msg.liveSearchState) {
                        case 'pauseLiveSearch':
                            this.pauseLiveSearch()
                            break
                        case 'resumeLiveSearch':
                            this.resumeLiveSearch()
                            break
                        case 'stopLiveSearch':
                            this.stopLiveSearch()
                            break
                        default:
                            break
                    }
                    break
                case 'getAutocomplete':
                    void this.autocompleteDisplay.getAutocomplete({
                        input: msg.input,
                        queryContext: {
                            should: queryContext.should,
                            must: queryContext.must,
                            mustNot: queryContext.mustNot,
                        },
                        panelId,
                    })
                    break
                case 'selectAutocompleteSuggestion':
                    session.recordEvent(TelemetryEventName.SELECT_AUTOCOMPLETE_QUERY_TEXT, {
                        autocompleteMetadata: {
                            input: msg.text,
                            selectedItem: msg.autocompleteSuggestionSelected,
                            suggestionsCount: msg.autocompleteSuggestionsCount,
                        },
                    })
                    break
                case 'clickCodeDetails':
                    session.recordEvent(TelemetryEventName.CLICK_CODE_DETAILS, {
                        codeDetailsMetadata: {
                            ...msg,
                        },
                    })
                    break
            }
        })
        panel.onDidDispose(_ => {
            // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
            delete this.uiReady[panelId]
            if (panelId === this.panelStore.getLiveSearchPanelId()) {
                this.removeStatusBarControl()
            }
            this.panelStore.deletePanel(panelId)
        })

        this.panelStore.savePanel(panelId, { webviewPanel: panel, telemetrySession: session })

        this.generatePanel(panelId, input, queryContext, live, query.codeSelection, query.codeQuery)
    }

    /**
     * This method translates trigger from Search model to trigger in Telemetry model.
     * Once trigger is removed from Search API this translation will no longer be required.
     */
    private getTelemetrySearchTrigger(searchModelTrigger: string): SearchTrigger {
        switch (searchModelTrigger) {
            case 'TerminalLink':
                return SearchTrigger.TERMINAL
            case 'DebugError':
                return SearchTrigger.DEBUG_ERROR
            case 'SearchBarInput':
                return SearchTrigger.GLOBAL_SEARCH
            case 'SearchBarRefinement':
                return SearchTrigger.SEARCH_PANE
            case 'DiagnosticError':
                return SearchTrigger.DIAGNOSTIC_ERROR
            case 'CodeSelection':
                return SearchTrigger.CODE_SELECTION
            default:
                return SearchTrigger.GLOBAL_SEARCH
        }
    }

    private generatePanel(
        panelId: string,
        input?: string,
        queryContext?: QueryContext,
        live?: boolean,
        codeSelection?: CodeSelection,
        codeQuery?: CodeQuery
    ): void {
        this.uiReady[panelId] = false
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const panel = this.panelStore.getPanel(panelId)!
        const source = 'src/mynah/ui/mynah-ui.js'
        const mynahLogo = getIcon('aws-mynah-logo')
        const logoPath = mynahLogo instanceof Icon ? mynahLogo.source : undefined
        const logoUri = logoPath ? panel.webviewPanel.webview.asWebviewUri(logoPath) : undefined
        const javascriptUri = vs.Uri.joinPath(this.assetsPath, 'dist', source)

        const context = queryContext !== undefined ? JSON.stringify(queryContext) : ''

        const codeSelectionString = codeSelection !== undefined ? JSON.stringify(codeSelection) : ''
        const codeQueryString = codeQuery !== undefined ? JSON.stringify(codeQuery) : ''
        const localLanguage = vs.env.language

        // Use the webpack dev server if available
        const serverHostname = process.env.WEBPACK_DEVELOPER_SERVER
        const entrypoint =
            serverHostname !== undefined
                ? vs.Uri.parse(serverHostname).with({ path: `/${source}` })
                : panel.webviewPanel.webview.asWebviewUri(javascriptUri)

        panel.webviewPanel.webview.html = getWebviewContent(
            entrypoint.toString(),
            logoUri,
            input,
            context,
            input !== undefined,
            live,
            codeSelectionString,
            codeQueryString,
            localLanguage
        )
    }

    private updateContent(
        panelId: string,
        input: string,
        trigger: Trigger,
        suggestions: SearchSuggestion[],
        queryContext?: QueryContext,
        codeQuery?: CodeQuery,
        codeSelection?: CodeSelection,
        errorMessage?: string
    ): void {
        const panel = this.panelStore.getPanel(panelId)

        if (panel === undefined) {
            return
        }

        if (this.uiReady[panelId]) {
            void panel.webviewPanel.webview.postMessage(
                JSON.stringify({
                    loading: false,
                    queryText: input,
                    context: queryContext !== undefined ? queryContext : undefined,
                    suggestions: errorMessage ?? suggestions,
                    codeQuery,
                    codeSelection,
                })
            )
        } else {
            setTimeout(() => {
                this.updateContent(
                    panelId,
                    input,
                    trigger,
                    suggestions,
                    queryContext,
                    codeQuery,
                    codeSelection,
                    errorMessage
                )
            }, 50)
            return
        }

        void this.searchHistoryStore.addRecord({
            query: {
                queryId: panelId,
                input,
                queryContext: queryContext ?? {
                    must: new Set<string>(),
                    should: new Set<string>(),
                    mustNot: new Set<string>(),
                },
                trigger: trigger ?? 'SearchBarRefinement',
                codeQuery,
                codeSelection,
            },
            suggestions,
            recordDate: new Date().getTime(),
        })
    }

    public showSearchSuggestions(output: SearchOutput): void {
        const query = output.query
        const queryId = query.queryId
        const fileName =
            query.codeSelection !== undefined
                ? query.codeSelection.file !== undefined
                    ? query.codeSelection.file.name
                    : ''
                : ''
        const selectionRangeStart =
            query.codeSelection?.file !== undefined
                ? `${query.codeSelection.file.range.start.row}:${query.codeSelection.file.range.start.column}`
                : ''
        const panelId = (query.implicit ?? false ? this.panelStore.getLiveSearchPanelId() : queryId) ?? queryId
        const panel = this.panelStore.getPanel(panelId)
        if (panel !== undefined) {
            panel.webviewPanel.title = this.getPanelTitle(query.input, fileName, selectionRangeStart)
            panel.webviewPanel.reveal(panel.webviewPanel.viewColumn, false)
        } else {
            this.setupPanel(panelId, query, query.implicit ?? false)
        }
        const startTime = Date.now()
        output.suggestions
            .then(async suggestions => {
                emitter.fire(suggestions)
                const suggestionsList = await Promise.all(
                    Object.entries(suggestions).map(([idx, suggestion]) => ({ ...suggestion, id: idx }))
                )
                const latency = Date.now() - startTime
                const panel = this.panelStore.getPanel(panelId)
                if (panel === undefined) {
                    return
                }
                panel.telemetrySession.recordEvent(TelemetryEventName.SHOW_RESULTS, {
                    resultMetadata: {
                        latency,
                        resultCount: suggestions.length,
                    },
                })
                this.updateContent(
                    panelId,
                    query.input,
                    query.trigger,
                    suggestionsList,
                    query.queryContext,
                    query.codeQuery,
                    query.codeSelection
                )
            })
            .catch((error: Error) => {
                console.error('An error occurred when waiting for suggestions:', error)
                this.updateContent(
                    panelId,
                    query.input,
                    query.trigger,
                    [],
                    query.queryContext,
                    query.codeQuery,
                    query.codeSelection,
                    'Something went wrong.'
                )
            })
        if (query.implicit ?? false) {
            this.panelStore.setLiveSearchPanelId(panelId)

            if (this.liveSearchStatusBarControl !== undefined) {
                this.liveSearchStatusBarControl.destroy()
                this.liveSearchStatusBarControl = undefined
            }

            this.liveSearchStatusBarControl = new StatusBar({
                text: 'Mynah live search',
                commands: {
                    Pause: LiveSearchCommands.PAUSE,
                    Stop: LiveSearchCommands.STOP,
                },
                tooltip: 'Control Mynah live search suggestions',
            })
        }
    }
}

const getWebviewContent = (
    scriptUri: string,
    logoUri?: vs.Uri,
    queryText?: string,
    context?: string,
    loading?: boolean,
    live?: boolean,
    codeSelection?: string,
    codeQuery?: string,
    language?: string
): string => `
<!DOCTYPE html>
<html>
    <head>
        <title>Mynah</title>
        <mynah-config logo-url="${logoUri}" query-text="${encodeURI(queryText ?? '')}"
        context="${encodeURI(context ?? '')}" code-selection="${encodeURI(
    codeSelection ?? ''
)}" code-query="${encodeURI(codeQuery ?? '')}" loading="${String(loading)}" live="${String(live)}" language="${String(
    language
)}"></mynah-config>
        <script type="text/javascript" src="${scriptUri}" defer onload="init()"></script>
        <script type="text/javascript" defer>
          function init(){
            const uiElements = new MynahUI();
            window.uiElements = uiElements;
          }
        </script>
    </head>

    <body>
    </body>
</html>
`
