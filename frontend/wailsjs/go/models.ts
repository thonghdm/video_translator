export namespace main {
	
	export class FolderNode {
	    name: string;
	    path: string;
	    is_dir: boolean;
	    has_cache?: boolean;
	    children?: FolderNode[];
	
	    static createFrom(source: any = {}) {
	        return new FolderNode(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.path = source["path"];
	        this.is_dir = source["is_dir"];
	        this.has_cache = source["has_cache"];
	        this.children = this.convertValues(source["children"], FolderNode);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Settings {
	    block_sec: number;
	    overlap_sec: number;
	    lookahead_min_sec: number;
	    lookahead_max_sec: number;
	    translate_workers: number;
	    whisper_threads: number;
	    source_lang: string;
	    translator: string;
	
	    static createFrom(source: any = {}) {
	        return new Settings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.block_sec = source["block_sec"];
	        this.overlap_sec = source["overlap_sec"];
	        this.lookahead_min_sec = source["lookahead_min_sec"];
	        this.lookahead_max_sec = source["lookahead_max_sec"];
	        this.translate_workers = source["translate_workers"];
	        this.whisper_threads = source["whisper_threads"];
	        this.source_lang = source["source_lang"];
	        this.translator = source["translator"];
	    }
	}
	export class SubtitleItem {
	    id: number;
	    block: number;
	    start_sec: number;
	    end_sec: number;
	    source_text: string;
	    target_text: string;
	    translated: boolean;
	
	    static createFrom(source: any = {}) {
	        return new SubtitleItem(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.block = source["block"];
	        this.start_sec = source["start_sec"];
	        this.end_sec = source["end_sec"];
	        this.source_text = source["source_text"];
	        this.target_text = source["target_text"];
	        this.translated = source["translated"];
	    }
	}
	export class VideoInfo {
	    path: string;
	    duration_sec: number;
	    block_sec: number;
	    total_blocks: number;
	    media_url: string;
	    playable: boolean;
	    playable_reason: string;
	    done_blocks: number[];
	
	    static createFrom(source: any = {}) {
	        return new VideoInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.duration_sec = source["duration_sec"];
	        this.block_sec = source["block_sec"];
	        this.total_blocks = source["total_blocks"];
	        this.media_url = source["media_url"];
	        this.playable = source["playable"];
	        this.playable_reason = source["playable_reason"];
	        this.done_blocks = source["done_blocks"];
	    }
	}

}

