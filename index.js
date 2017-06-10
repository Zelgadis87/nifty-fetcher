
const request = require( 'request-promise' )
	, Bluebird = require( 'bluebird' )
	, _ = require( 'lodash' )
	, path = require( 'path' )
	, console = require( 'console' )
	, xpath = require( 'xpath.js' )
	, DOMParser = require( 'xmldom' ).DOMParser
	, MultiSpinner = require( 'multispinner' )
	, yazl = require( 'yazl' )
	, fs = Bluebird.promisifyAll( require( 'fs' ) )
	;

let baseUrl = 'http://www.nifty.org/nifty';

function urlTemplate( orientation, category, title ) {
	return `${ baseUrl }/${ orientation }/${ category }/${ title }/`;
}

function recursiveMkDir( argDir ) {
	var promise = Bluebird.resolve(),
		currentPath = "";
	_.each( argDir.split( path.sep ), function( argSplit, argIdx ) {
		currentPath = path.join( currentPath, argSplit + '\\' );
		if ( argIdx == 0 ) return; // Skip mkdir-ing the drive.
		promise = promise
			.return( currentPath )
			.then( fs.mkdirAsync )
			.catch( ( err ) => {
				// Output folder already existing is expected, it's not a problem.
				// Other types of error should be thrown.
				if ( err.code !== 'EEXIST' ) throw err;
			} );
	} );
	return promise;
}

function downloadLink( baseUrl, link ) {
	return request( baseUrl + link ).then( data => {
		return {
			href: link,
			name: path.basename( link ),
			content: data
		};
	} );
}

function main() {

	// TODO: Input
	let orientation = 'gay';
	let category = 'sf-fantasy';
	let name = 'the-paths-end';
	let url = urlTemplate( orientation, category, name );

	let dataDir = path.join( __dirname, 'data' );
	let outputName = `${ name }.zip`;
	let outputPath = path.join( dataDir, outputName );

	return Bluebird.resolve( recursiveMkDir( dataDir ) )
		.tap( () => console.info( 'Fetching info...' ) )
		.then( () => request( url ) )
		.then( html => new DOMParser( { errorHandler: _.noop } ).parseFromString( html ) )
		.then( dom => xpath( dom, '//table/descendant::a/@href' ) )
		.map( href => href.value )
		// .then( links => _.reverse( links ) )
		// TODO: Progress
		.tap( () => console.info( 'Fetch complete. Downloading contents...' ) )
		.then( links => {
			let spinners = new MultiSpinner( links );
			return Bluebird.all( _.map( links, link => downloadLink( url, link ).tap( spinners.success( link ) ) ) );
		} )
		.tap( () => console.info( 'Download complete. Processing contents...' ) )
		.then( data => {

			let promise = new Bluebird( ( resolve ) => {

				let spinner = new MultiSpinner( [ outputName ] );
				let zipfile = new yazl.ZipFile();

				zipfile.outputStream.pipe( fs.createWriteStream( outputPath ) ).on( 'close', () => spinner.success( outputName ) );
				_.each( data, ( d, i ) => zipfile.addBuffer( new Buffer( d.content ), `${ _.padStart( i + 1, data.length.toString().length, '0' ) }-${ d.name }` ) );
				zipfile.end();

				spinner.on( 'done', resolve );

			} );

			return promise;

		} )
		.tap( () => console.info( 'Process complete. Output available as: ' + outputPath ) );

}

main();
