export namespace main {
	
	export class DriveItem {
	    id: string;
	    name: string;
	    mime_type: string;
	    size: number;
	    thumbnail_link: string;
	    is_folder: boolean;
	    duration_sec: number;
	    subtitle_id: string;
	    subtitle_name: string;
	
	    static createFrom(source: any = {}) {
	        return new DriveItem(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.mime_type = source["mime_type"];
	        this.size = source["size"];
	        this.thumbnail_link = source["thumbnail_link"];
	        this.is_folder = source["is_folder"];
	        this.duration_sec = source["duration_sec"];
	        this.subtitle_id = source["subtitle_id"];
	        this.subtitle_name = source["subtitle_name"];
	    }
	}
	export class DriveLinkInfo {
	    kind: string;
	    id: string;
	    name: string;
	    duration_sec: number;
	    subtitle_id: string;
	
	    static createFrom(source: any = {}) {
	        return new DriveLinkInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.kind = source["kind"];
	        this.id = source["id"];
	        this.name = source["name"];
	        this.duration_sec = source["duration_sec"];
	        this.subtitle_id = source["subtitle_id"];
	    }
	}
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
	    gemini_api_key?: string;
	    gemini_enabled?: boolean;
	    gemini_model?: string;
	
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
	        this.gemini_api_key = source["gemini_api_key"];
	        this.gemini_enabled = source["gemini_enabled"];
	        this.gemini_model = source["gemini_model"];
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
	export class UpdateCheckResult {
	    has_update: boolean;
	    current_version: string;
	    latest_version: string;
	    release_date: string;
	    changelog: string;
	    download_url: string;
	    file_size_mb: number;
	    mandatory: boolean;
	
	    static createFrom(source: any = {}) {
	        return new UpdateCheckResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.has_update = source["has_update"];
	        this.current_version = source["current_version"];
	        this.latest_version = source["latest_version"];
	        this.release_date = source["release_date"];
	        this.changelog = source["changelog"];
	        this.download_url = source["download_url"];
	        this.file_size_mb = source["file_size_mb"];
	        this.mandatory = source["mandatory"];
	    }
	}
	export class VideoInfo {
	    path: string;
	    title?: string;
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
	        this.title = source["title"];
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

