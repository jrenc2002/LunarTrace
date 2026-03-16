import { Component, Input, OnInit } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { IframeComponent } from '../../windows/iframe/iframe.component';

@Component({
  selector: 'app-graph-editor',
  standalone: true,
  imports: [IframeComponent],
  templateUrl: './graph-editor.component.html',
  styleUrl: './graph-editor.component.scss',
})
export class GraphEditorComponent implements OnInit {
  @Input() url?: string;

  resolvedUrl = '';

  private readonly defaultUrl = 'https://tool.aily.pro/connection-graph?type=json&theme=dark';
  // private readonly defaultUrl = 'http://localhost:4201/connection-graph?type=json&theme=dark';

  constructor(private route: ActivatedRoute) {}

  ngOnInit(): void {
    this.resolvedUrl =
      this.url ??
      this.route.snapshot.queryParams['url'] ??
      this.defaultUrl;
  }
}
