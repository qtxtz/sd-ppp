import i18n, { I18nKey } from "../../../common/i18n.mjs";
import { SpeicialIDManager } from "../../../common/photoshop/specialLayer.mjs";
import { LayerData } from "../../../plugins/common/store/photoshop.mjs";
import { pagePhotoshopStoreMap, pageStore } from "../../common/models/photoshopModels.mjs";
import { findDocumentNodeRecursive, getLayerOptionsByDocumentValue, isPhotoshopConnected, makeDocumentDataOptions, makeDocumentOption, parseDocumentOption } from "../../common/util.mjs";
import { ComfySocket } from "../socket/ComfySocket.mjs";

export abstract class SDPPPWidget {
    widget: any
    node: any
    protected originLabel: string = ''
    protected indexInNode: number = 0
    constructor(node: any, widget: any) {
        this.widget = widget;
        this.node = node;
        this.indexInNode = node.widgets.indexOf(widget);
        const self = this
        widget.callback = function (...args: any[]) {
            if (self.widget != this) {
                // 0222 temp fix, ComfyUI side will create new Widget when type changed. 
                // But did not assign the new one to node.widgets[]
                self.widget = self.node.widgets[self.indexInNode] = this
            }
            self._callbacks.forEach(callback => callback(...args))
        }
        this.originLabel = widget.label
    }

    private _callbacks: ((...args: any[]) => any)[] = [];
    public onChange(callback: (...args: any[]) => any) {
        this._callbacks.push(callback);
    }
    public removeOnChange(callback: (...args: any[]) => any) {
        this._callbacks.splice(this._callbacks.indexOf(callback), 1);
    }
    public abstract update(): void;
}
export abstract class SDPPPComboWidget extends SDPPPWidget {
    public lockMode(isLock: boolean, lockLabel: string) {
        if (isLock) {
            if (this.widget.type == 'button') return;
            this.widget.type = 'button'
            this.widget.value = '';
            this.widget.label = lockLabel;

        } else {
            if (this.widget.type == 'combo') return;
            this.widget.type = 'combo'
            this.widget.value = '';
            this.widget.label = this.originLabel;
        }
    }
}
export class DocumentWidget extends SDPPPComboWidget {
    static create(node: any, name: I18nKey) {
        const options: string[] = makeDocumentDataOptions();
        const size = node.size.slice(0);
        const documentWidget = node.addWidget('combo', name, options[0] || '', () => { }, { forceInput: true, values: makeDocumentDataOptions })
        documentWidget.serializeValue = async () => {
            const data = parseDocumentOption(documentWidget.value);
            if (!data) return '';
            return JSON.stringify({
                instance_id: data.instance_id,
                identify: data.identify
            });
        }
        node.size = [size[0], Math.max(size[1], node.size[1])];
        return new DocumentWidget(node, documentWidget);
    }
    static link(node: any, widget: any) {
        if (widget.type == "combo") {
            return new DocumentWidget(node, widget);
        }
        const dWidget = DocumentWidget.create(node, widget.name);
        const oldWidgetIndex = node.widgets.indexOf(widget);
        node.widgets[oldWidgetIndex] = node.widgets.pop();
        return dWidget;
    }

    constructor(node: any, widget: any) {
        super(node, widget);
        this.onChange((value: any) => {
            if (!isNaN(+value)) { // is number
                widget.value = Object.keys(widget.options.values)[+value];

            } else if (typeof value == 'string') { // is string
                const split = value.split('/');
                if (SpeicialIDManager.is_SPECIAL_DOCUMENT_CURRENT(split[1])) {
                    widget.value = split[0] + '/' + SpeicialIDManager.getSpecialDocumentCurrent();
                }
            }
        });
    }

    public update() {
        widgetCheckContainOrReset(this.widget, this.widget.options.values, true)
    }

    public selectConcreteDocument() {
        if (
            SpeicialIDManager.is_SPECIAL_DOCUMENT_CURRENT(this.widget.value)
        ) {
            const [instanceKey,] = this.widget.value.split('/');
            const store = pagePhotoshopStoreMap.getStoreByName(instanceKey);
            if (!store) return console.warn(`store ${instanceKey} not found`);
            // @ts-ignore
            this.widget.value = makeDocumentOption(store.data.documents[store.data.activeDocumentID].identify, instanceKey)
        }
    }
}
export interface LayerWidgetCtorOptions {
    extraOptions: string[]
}
interface LayerWidgetWithDocumentSelectionCtorOptions extends LayerWidgetCtorOptions {
    documentWidgetInNode: DocumentWidget | null,
}
export class LayerWidget extends SDPPPComboWidget {
    protected documentWidgetByLinked: DocumentWidget | null = null;
    protected extraOptions: string[];
    constructor(node: any, layerWidget: any, options: LayerWidgetCtorOptions) {
        super(node, layerWidget);
        this.extraOptions = options.extraOptions;
        this.update = this.update.bind(this);
        
        this.onChange((value) => {
            this.node.setProperty('layerWidgetDetail' + this.indexInNode, this.currentOptionsDetail[Object.values(this.currentOptions).indexOf(this.widget.value)]);

            if (typeof value == 'string') { // is string
                value = SpeicialIDManager.fixI18n(value);
            }
        })
    }
    static create(node: any, name: I18nKey, options: LayerWidgetWithDocumentSelectionCtorOptions) {
        const size = node.size.slice(0);
        const layerWidget = node.addWidget('combo', name, options.extraOptions[0] || '', () => { }, { forceInput: true, values: options.extraOptions })
        

        node.size = [size[0], Math.max(size[1], node.size[1])];
        return new LayerWidgetWithDocumentSelection(node, layerWidget, {
            documentWidgetInNode: options.documentWidgetInNode,
            extraOptions: options.extraOptions
        });
    }

    public linkDocumentWidget(documentWidget: DocumentWidget | null) {
        if (this.documentWidgetByLinked) {
            documentWidget?.removeOnChange(this.update)
        }
        this.documentWidgetByLinked = documentWidget;
        if (this.documentWidgetByLinked) {
            this.documentWidgetByLinked.onChange(this.update)
        }
    }
    public update() {
        const documentWidget = this.documentWidgetByLinked;
        this.updateOptions(documentWidget);
    }

    protected currentOptions: string[] = []
    protected currentOptionsDetail: LayerData[] = []

    protected updateOptions(documentWidget: DocumentWidget | null) {
        this.currentOptions = this.extraOptions.slice(0)
        this.currentOptionsDetail = new Array(this.currentOptions.length).fill({ id: 0, name: '', identify: '', level: 0, fullPath: '' });

        if (documentWidget && documentWidget.widget.value) {
            const document = parseDocumentOption(documentWidget.widget.value);
            if (!document) return;
            document.documentData.layers.map((layer: LayerData) => {
                this.currentOptions.push(layer.identify)
                this.currentOptionsDetail.push(layer);
            })
        }
        this.widget.options.values = this.currentOptions;
        if (Object.values(this.currentOptions).indexOf(this.widget.value) == -1) {
            const originDetail: LayerData | null = this.node.properties['layerWidgetDetail' + this.indexInNode]
            if (originDetail) {
                const findIndex = this.currentOptionsDetail.findIndex(item => item.fullPath == originDetail.fullPath)
                if (findIndex != -1) {
                    this.widget.value = this.currentOptions[findIndex]
                    return;
                }
            }
            // or set the node to red
        }
    }
}
const defaultLayerWidgetWithDocumentSelectionOptions: LayerWidgetWithDocumentSelectionCtorOptions = {
    extraOptions: [],
    documentWidgetInNode: null
}
export class LayerWidgetWithDocumentSelection extends LayerWidget {
    private readonly documentWidgetInNode: DocumentWidget | null;

    constructor(node: any, layerWidget?: any, options: LayerWidgetWithDocumentSelectionCtorOptions = defaultLayerWidgetWithDocumentSelectionOptions) {
        super(node, layerWidget, options);
        this.documentWidgetInNode = options.documentWidgetInNode;
        this.onChange(() => {
            const documentWidget = this.documentWidgetInNode || this.documentWidgetByLinked;
            documentWidget?.selectConcreteDocument();
        })
        this.documentWidgetInNode?.onChange(this.update)
    }
    public override update() {
        const documentWidget = this.documentWidgetInNode || this.documentWidgetByLinked;
        if (documentWidget?.widget.value) {
            this.widget.options.values = getLayerOptionsByDocumentValue(documentWidget.widget.value, this.extraOptions)
            widgetCheckContainOrReset(this.widget, this.widget.options.values)
        }
    }
}
export interface BoundaryWidgetCtorOptions {
    extraOptions: string[]
}

let lastDownloadTime = 0;
declare const app: any;
export class DownloadWidget extends SDPPPWidget {
    constructor(node: any, widget?: any) {
        if (!widget) {
            const size = node.size.slice(0);
            widget = node.addWidget('button', 'sdppp', '', () => { })
            node.size = [
                size[0],
                Math.max(size[1], node.size[1])
            ];
            widget.serializeValue = async () => {
                const ret: any = {
                    ps_maxGetImageWH: pageStore.data.maxImageWH
                }
                const documentNode = findDocumentNodeRecursive(node);
                if (documentNode?.widgets[0]) {
                    const val = await documentNode.widgets[0].serializeValue();
                    try {
                        ret.document = JSON.parse(val);
                    } catch (e) {
                        return '';
                    }
                }
                return JSON.stringify(ret);
            }
        }
        super(node, widget);
        this.onChange(() => {
            if (pagePhotoshopStoreMap.storeCount() == 0 && Date.now() - lastDownloadTime > 3000) {
                lastDownloadTime = Date.now();
                location.href = "/sd-ppp-static/sd-ppp_PS.ccx?_=" + Date.now();
                // comfy app
                setTimeout(() => {
                    app.ui.dialog.show(`<h2 
                        style="color: var(--fg-color);">${i18n('How to use .ccx file')}</h2><h4 
                        style="color: var(--fg-color);">${i18n('1. If you have installed Adobe Creative Cloud')}</h4><p 
                        style="color: var(--fg-color);">${i18n('Just double click the .ccx file, it will install the plugin automatically')}</p><h4 
                        style="color: var(--fg-color);">${i18n("2. If you don't have Adobe Creative Cloud")}</h4><p 
                        style="color: var(--fg-color);">${i18n('Rename .ccx to .zip and extract it into ')}<i>[${i18n('Photoshop directory')}]/Plug-ins</i> ${i18n('or')} <i>[${i18n('Photoshop directory')}]/Plug-ins/Generator</i></p><img 
                        width=400 src="/sd-ppp-static/ccx-help.png"/>
                    `)
                }, 300);
            }
        })
    }

    update() {
        this.widget.label = pagePhotoshopStoreMap.storeCount() > 0 && ComfySocket.instance.id ?
            i18n('current ComfyUI pageid: {0}', ComfySocket.instance.id.slice(0, 4)) :
            i18n('download PS plugin (.ccx)');
    }
 
    private documentWidgetByLinked: DocumentWidget | null = null;
    public linkDocumentWidget(documentWidget: DocumentWidget | null) {
        this.documentWidgetByLinked = documentWidget;
    }
}



export function widgetCheckContainOrReset(widget: any, options: string[] | (() => string[]), resetIfNotContain: boolean = false) {
    if (options instanceof Function) options = options();
    if (!widget.value) widget.value = options[0];
    if (options.indexOf(widget.value) == -1) {
        if (resetIfNotContain) widget.value = options[0];
    }
}
